# Enterprise Connector Architecture

> **Comprehensive Design for SearchAI Connectors**
>
> **Version**: 1.0
> **Status**: Design Phase
> **Last Updated**: 2026-02-23
> **Authors**: ABL Platform Team

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Core Requirements](#2-core-requirements)
3. [Pilot Connectors](#3-pilot-connectors)
4. [System Architecture](#4-system-architecture)
5. [Permission & Authorization](#5-permission--authorization)
6. [User Identity & Activity Tracking](#6-user-identity--activity-tracking)
7. [Multi-Type Data Ingestion](#7-multi-type-data-ingestion)
8. [Attachments Support](#8-attachments-support)
9. [Selective Data Ingestion & Filtering](#9-selective-data-ingestion--filtering)
10. [Configurable Permission Crawling & OAuth Scopes](#10-configurable-permission-crawling--oauth-scopes)
11. [CLI-First Configuration](#11-cli-first-configuration)
12. [Progress Tracking & ETA](#12-progress-tracking--eta)
13. [Failure Handling (Pause/Resume/Skip)](#13-failure-handling-pauseresumeskip)
14. [Intelligent Rate Limiting](#14-intelligent-rate-limiting)
15. [Webhook Support](#15-webhook-support)
16. [Incremental Sync & Real-Time Updates](#16-incremental-sync--real-time-updates)
17. [Data Reconciliation & Missing Content Detection](#17-data-reconciliation--missing-content-detection)
18. [Observability & Monitoring](#18-observability--monitoring)
19. [Data Models](#19-data-models)
20. [API Specification](#20-api-specification)
21. [Implementation Roadmap](#21-implementation-roadmap)

---

## 1. Executive Summary

### 1.1 Purpose

This document defines a **production-grade enterprise connector architecture** for SearchAI that:

- ✅ **Respects user permissions** at document level during search
- ✅ **Authenticates users** with external sources (OAuth 2.0, SAML, API keys)
- ✅ **Tracks user activity** and relationships for intelligent boosting
- ✅ **Ingests diverse data types** (articles, files, issues, bugs) with specialized chunking
- ✅ **Handles attachments** (PDFs on Jira comments, Confluence inline attachments, email attachments)
- ✅ **Supports selective ingestion** with user-configurable filters (projects, labels, date ranges, status)
- ✅ **Provides flexible permission crawling** that can be disabled to optimize performance
- ✅ **Provides visibility** with progress tracking, ETA, and comprehensive observability
- ✅ **Handles failures gracefully** with pause/resume/skip capabilities
- ✅ **Respects external limits** with intelligent rate limiting and batching
- ✅ **Supports real-time updates** via webhooks
- ✅ **Maintains data freshness** with incremental sync and permission updates
- ✅ **Detects and reconciles missing data** from sync gaps, webhook failures, or backend bugs

### 1.2 Design Principles

1. **Security First**: Permissions verified at query time, credentials encrypted at rest
2. **User-Centric**: Every search respects the querying user's access rights
3. **Resilient**: Automatic retry, backoff, and failure isolation
4. **Observable**: Complete visibility into sync status, failures, and search metrics
5. **Scalable**: Supports thousands of tenants and millions of documents
6. **Extensible**: Standard interface allows adding new connectors easily

### 1.3 Pilot Connectors

We will implement the architecture with **5 pilot connectors**:

| Connector      | Data Types                       | Auth Method                 | Key Challenges                                          |
| -------------- | -------------------------------- | --------------------------- | ------------------------------------------------------- |
| **SharePoint** | Files, Lists, Pages              | OAuth 2.0                   | Complex permissions (site/folder/item), version history |
| **Confluence** | Pages, Blogs, Attachments        | OAuth 2.0 + Personal Tokens | Space permissions, page hierarchy, inline attachments   |
| **Jira**       | Issues, Comments, Attachments    | OAuth 2.0 + Personal Tokens | Permission schemes, custom fields, comment attachments  |
| **HubSpot**    | Deals, Tickets, Companies        | API Key + OAuth             | Activity tracking, relationship graph                   |
| **ServiceNow** | Incidents, Requests, KB Articles | OAuth 2.0                   | Role-based access, cross-table relationships            |

---

## 2. Core Requirements

### 2.1 Permission & Authorization (R1 & R2)

**Requirement**: Users can only search documents they have access to in the source system.

**Key Challenges**:

- External systems have different permission models (ACLs, roles, groups)
- Permissions change over time
- Group membership changes
- Documents can be shared/unshared dynamically

**Solution**: See [Section 5](#5-permission--authorization)

### 2.2 User Identity & Activity Tracking (R3)

**Requirement**: Track user insights, activity at sources, peers, and managers for intelligent boosting.

**Key Challenges**:

- Identity mapping across systems (email, username, SSO ID)
- Activity signals vary by source (views, edits, comments, shares)
- Organizational hierarchy changes
- Privacy and compliance (GDPR, data minimization)

**Solution**: See [Section 6](#6-user-identity--activity-tracking)

### 2.3 Multi-Type Data Ingestion (R4)

**Requirement**: Ingest diverse data types with specialized chunking strategies.

**Key Challenges**:

- Files (PDF, DOCX, XLSX) vs structured data (issues, tickets) need different processing
- Tables, images, and metadata require special handling
- Some sources have nested data (comments on issues, attachments on tickets)

**Solution**: See [Section 7](#7-multi-type-data-ingestion)

### 2.4 Progress Tracking & ETA (R5)

**Requirement**: Identify total objects per source and provide accurate ETA.

**Key Challenges**:

- Some APIs don't provide total counts upfront
- Processing time varies by document type
- Rate limits affect throughput

**Solution**: See [Section 8](#8-progress-tracking--eta)

### 2.5 Failure Handling (R6)

**Requirement**: Pause, resume, or skip based on failures.

**Key Challenges**:

- Distinguish transient vs permanent failures
- Resume from exact failure point without duplication
- Handle partial failures (some documents succeed, some fail)

**Solution**: See [Section 9](#9-failure-handling-pauseresumeskip)

### 2.6 Intelligent Rate Limiting (R7)

**Requirement**: Honor external system limits with intelligent batching and waiting.

**Key Challenges**:

- Different connectors have different limits
- Limits can be per-user, per-tenant, or per-app
- Some systems have burst limits + sustained limits
- Concurrent sync jobs must share quota

**Solution**: See [Section 10](#10-intelligent-rate-limiting)

### 2.7 Webhook Support (R8)

**Requirement**: Support webhooks for fast indexing of new/changed documents.

**Key Challenges**:

- Webhook security (signature verification)
- Deduplication with scheduled syncs
- Handling webhook storms (bulk operations)
- Mapping webhook events to document changes

**Solution**: See [Section 11](#11-webhook-support)

### 2.8 Incremental Sync & Real-Time Permissions (R9)

**Requirement**: Auto incremental sync and near-real-time permission updates.

**Key Challenges**:

- Change detection (what changed since last sync)
- Permission deltas (what permissions changed)
- Handling deletions and moves
- Cursor-based pagination vs change tokens

**Solution**: See [Section 12](#12-incremental-sync--real-time-updates)

### 2.9 Complete Observability (R10)

**Requirement**: Full visibility of failures, success, and document search.

**Key Challenges**:

- High-cardinality data (millions of documents)
- Real-time vs batch metrics
- Correlation across stages (fetch → extract → chunk → index → search)

**Solution**: See [Section 13](#13-observability--monitoring)

---

## 3. Pilot Connectors

### 3.1 SharePoint Online

**Data Sources**:

- Sites, Document Libraries, Lists, Pages
- Files (Office docs, PDFs, images)
- Metadata (created, modified, author, version)

**Permission Model**:

- Site-level: Site Owners, Members, Visitors
- Folder-level: Inherited or unique permissions
- Item-level: Can have unique permissions
- Groups: SharePoint groups + Azure AD groups

**API**:

- Microsoft Graph API
- SharePoint REST API
- Webhook: List subscriptions (30-day max)

**Rate Limits**:

- Graph API: 10,000 requests per 10 minutes per app
- Throttling: HTTP 429 with Retry-After header

**Auth**:

- OAuth 2.0 (delegated or application permissions)
- App-only: `Sites.Read.All` for full access
- Delegated: Respects user permissions

**Challenges**:

- Complex permission inheritance
- Version history (do we index all versions?)
- Large libraries (1M+ items)
- Throttling during bulk operations

### 3.2 Confluence

**Data Sources**:

- Spaces, Pages, Blogs
- Comments
- Attachments (inline images, PDFs, files)
- Labels and macros
- Page history and versions

**Permission Model**:

- Space-level: View, Add, Edit, Delete, Admin
- Page-level: Can inherit from space or have custom restrictions
- Anonymous access: Pages can be public
- Group-based: Permissions granted to groups

**API**:

- Confluence REST API v1 & v2
- Cloud vs Server/Data Center (different endpoints)
- Content API: Fetch pages, blogs, comments
- Attachment API: Download and extract attachments
- Search API: Built-in CQL (Confluence Query Language)

**Rate Limits**:

- Cloud: No official limit, but throttled under load
- Server/Data Center: Configurable

**Auth**:

- OAuth 2.0 (Cloud)
- Personal Access Tokens (Cloud & Data Center)
- Basic Auth (deprecated but still works in Server)

**Challenges**:

- Inline attachments (images embedded in page content via `<ac:image>` macro)
- Page hierarchy (parent-child relationships)
- Macro expansion (some content is in macros, not plain text)
- Version history (do we index all versions or just latest?)
- Large pages (some pages >50k words with many attachments)

### 3.3 HubSpot

**Data Sources**:

- CRM Objects: Contacts, Companies, Deals, Tickets
- Engagements: Emails, Calls, Meetings, Notes
- Custom Objects
- Knowledge Base Articles

**Permission Model**:

- User roles: Super Admin, Admin, User, View-only
- Team-based access (sales team, support team)
- Object-level: Public vs private records
- Record ownership: Owner can always access

**API**:

- HubSpot API v3
- Webhooks: Real-time notifications for object changes
- Batch APIs for bulk operations

**Rate Limits**:

- Free: 100 requests per 10 seconds
- Professional: 150 requests per 10 seconds
- Enterprise: Configurable

**Auth**:

- OAuth 2.0 (user authorization)
- Private app access tokens (app-level)

**Challenges**:

- Activity signals (email opens, deal stage changes)
- Custom properties (flexible schema)
- Relationship graph (companies ↔ contacts ↔ deals)

### 3.4 ServiceNow

**Data Sources**:

- Incidents, Requests, Problems, Changes
- Knowledge Base (KB) Articles
- CMDB (Configuration Items)
- Custom Tables

**Permission Model**:

- Role-based: admin, itil, catalog_admin, etc.
- Access Control Lists (ACLs) on tables/fields
- Assignment groups: Users in group can access assigned items
- Before/after query business rules can filter results

**API**:

- ServiceNow REST API (Table API, Import Set API)
- Webhook: Flow Designer can trigger webhooks
- Attachment API for files

**Rate Limits**:

- Default: 1000 requests per tenant per hour
- Configurable per instance

**Auth**:

- OAuth 2.0
- Basic Auth (username/password)
- API Key (x-servicenow-apikey)

**Challenges**:

- Complex ACL evaluation (role + condition)
- Cross-table joins (incident → assigned user → group)
- Change history tracking
- Large attachment volumes

### 3.5 Jira

**Data Sources**:

- Issues (Bugs, Stories, Tasks, Epics)
- Comments, Worklogs
- Attachments
- Custom Fields

**Permission Model**:

- Project-level: Browse, View, Edit, Admin
- Issue-level: Reporter, Assignee, Project Role
- Permission schemes: Map roles to permissions
- Issue security schemes: Additional restrictions

**API**:

- Jira REST API v3
- Webhooks: Issue events (created, updated, deleted)
- Attachment API

**Rate Limits**:

- Cloud: 5,000 requests per hour per IP
- Server: Configurable

**Auth**:

- OAuth 2.0 (3-legged for user context)
- Personal Access Tokens
- API Tokens (for Cloud)

**Challenges**:

- Permission scheme complexity
- Custom fields (vary by project)
- Hierarchical issues (Epic → Story → Sub-task)
- Activity tracking (who viewed, commented, transitioned)

---

## 4. System Architecture

### 4.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           SEARCH AI PLATFORM                        │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    CONNECTOR LAYER                            │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  SharePoint  │  HubSpot  │  ServiceNow  │  Jira  │  ...      │  │
│  │   Connector  │ Connector │   Connector  │Connector│           │  │
│  └──────────────────────────────────────────────────────────────┘  │
│         │              │              │              │              │
│         ↓              ↓              ↓              ↓              │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │               SYNC ORCHESTRATION ENGINE                       │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  • Sync Job Scheduler (Cron + Webhook triggers)               │  │
│  │  • Rate Limit Manager (Token bucket, backoff)                 │  │
│  │  • Progress Tracker (ETA, current status)                     │  │
│  │  • Failure Handler (Pause, resume, skip)                      │  │
│  │  • Change Detection (Incremental sync, deltas)                │  │
│  └──────────────────────────────────────────────────────────────┘  │
│         │                                                            │
│         ↓                                                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                INGESTION PIPELINE                             │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  EXTRACT → MAP → CHUNK → ENRICH → EMBED → INDEX             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│         │                                                            │
│         ↓                                                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   DATA STORES                                 │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  • MongoDB: Metadata, sync state, permissions cache           │  │
│  │  • OpenSearch: Vector + full-text index                       │  │
│  │  • Redis: Rate limit counters, job queue (BullMQ)             │  │
│  │  • PostgreSQL: User activity, relationships (optional)        │  │
│  └──────────────────────────────────────────────────────────────┘  │
│         │                                                            │
│         ↓                                                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │               PERMISSION ENFORCEMENT LAYER                    │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  • Query-time permission filter (ACL evaluation)              │  │
│  │  • User identity resolver (email → source user ID)            │  │
│  │  • Permission cache (TTL: 5 minutes)                          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│         │                                                            │
│         ↓                                                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                     SEARCH API                                │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  POST /api/search/:indexId/query                              │  │
│  │  • Extracts user context from auth token                      │  │
│  │  • Resolves user permissions for sources                      │  │
│  │  • Adds ACL filter to vector/hybrid query                     │  │
│  │  • Boosts results based on user activity                      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Component Responsibilities

| Component              | Responsibility                         | Key Classes                                          |
| ---------------------- | -------------------------------------- | ---------------------------------------------------- |
| **Connector**          | Fetch documents from external source   | `IConnector`, `SharePointConnector`, `JiraConnector` |
| **Sync Orchestrator**  | Schedule and coordinate sync jobs      | `SyncScheduler`, `SyncJobExecutor`                   |
| **Rate Limiter**       | Enforce API rate limits                | `RateLimitManager`, `TokenBucket`                    |
| **Progress Tracker**   | Track sync progress and calculate ETA  | `ProgressTracker`, `ETACalculator`                   |
| **Failure Handler**    | Handle failures, retries, pause/resume | `FailureHandler`, `RetryStrategy`                    |
| **Ingestion Pipeline** | Extract, chunk, embed, index documents | `PipelineExecutor`, `StageHandler`                   |
| **Permission Manager** | Store and enforce document permissions | `PermissionManager`, `ACLEvaluator`                  |
| **User Resolver**      | Map search user to source identities   | `UserIdentityResolver`, `IdentityMapper`             |
| **Activity Tracker**   | Track user interactions for boosting   | `ActivityTracker`, `RelationshipGraph`               |
| **Webhook Handler**    | Process real-time updates from sources | `WebhookReceiver`, `EventProcessor`                  |

---

## 5. Permission & Authorization

### 5.1 Permission Model

**Core Principle**: Every document has an Access Control List (ACL) stored at index time. At query time, we filter results to only documents the user can access.

#### 5.1.1 Permission Storage

```typescript
interface DocumentPermissions {
  documentId: string;
  sourceType: 'sharepoint' | 'jira' | 'hubspot' | 'servicenow';
  sourceDocumentId: string; // ID in the source system

  // Access Control List
  acl: {
    // Users with direct access (by source user ID or email)
    users: string[];
    // Groups with access (by source group ID)
    groups: string[];
    // Roles with access (for RBAC systems)
    roles: string[];
    // Special: "public" = everyone, "authenticated" = any logged-in user
    visibility: 'private' | 'authenticated' | 'public';
  };

  // Permission metadata
  inheritedFrom?: string; // Parent document/folder ID if inherited
  lastSyncedAt: Date;
  permissionVersion: number; // Increments on permission change
}
```

**Storage**:

- Primary: MongoDB `document_permissions` collection
- Index: OpenSearch `acl_users[]` and `acl_groups[]` fields for fast filtering
- Cache: Redis (5-minute TTL) for frequently accessed permissions

#### 5.1.2 Permission Extraction

Each connector implements `extractPermissions()`:

**SharePoint Example**:

```typescript
async extractPermissions(
  itemId: string,
  graphClient: GraphClient
): Promise<DocumentPermissions> {
  // Get item permissions
  const permissions = await graphClient
    .sites(siteId)
    .lists(listId)
    .items(itemId)
    .permissions
    .get();

  const acl = {
    users: [],
    groups: [],
    roles: [],
    visibility: 'private'
  };

  for (const perm of permissions) {
    if (perm.grantedToIdentitiesV2) {
      for (const identity of perm.grantedToIdentitiesV2) {
        if (identity.user) {
          acl.users.push(identity.user.email || identity.user.id);
        }
        if (identity.group) {
          acl.groups.push(identity.group.id);
        }
      }
    }

    // Check if inherited
    if (perm.inheritedFrom) {
      return {
        documentId,
        sourceType: 'sharepoint',
        sourceDocumentId: itemId,
        acl,
        inheritedFrom: perm.inheritedFrom.id,
        lastSyncedAt: new Date(),
        permissionVersion: 1
      };
    }
  }

  return { documentId, sourceType: 'sharepoint', sourceDocumentId: itemId, acl };
}
```

**Jira Example**:

```typescript
async extractPermissions(
  issueKey: string,
  jiraClient: JiraClient
): Promise<DocumentPermissions> {
  // Jira uses permission schemes at project level
  const issue = await jiraClient.getIssue(issueKey, {
    fields: ['project', 'reporter', 'assignee', 'security']
  });

  const projectPerms = await jiraClient.getProjectPermissions(issue.fields.project.key);

  const acl = {
    users: [
      issue.fields.reporter.accountId,
      issue.fields.assignee?.accountId
    ].filter(Boolean),
    groups: [],
    roles: projectPerms.roles, // e.g., ['Developers', 'Project Admins']
    visibility: issue.fields.security ? 'private' : 'authenticated'
  };

  return {
    documentId: uuidv7(),
    sourceType: 'jira',
    sourceDocumentId: issueKey,
    acl,
    lastSyncedAt: new Date(),
    permissionVersion: 1
  };
}
```

### 5.2 User Identity Resolution

**Challenge**: Search user's identity in SearchAI (email/SSO) must map to their identity in each source system.

**Solution**: `UserIdentityMapping` table

```typescript
interface UserIdentityMapping {
  searchUserId: string; // Our user ID (from auth token)
  searchUserEmail: string;

  mappings: {
    sourceType: string;
    sourceUserId: string; // User ID in that system
    sourceUserEmail: string;
    groups: string[]; // Groups user belongs to in that system
    roles: string[]; // Roles user has in that system
    lastSyncedAt: Date;
  }[];
}
```

**How Mappings are Created**:

1. **OAuth Flow**: When user authorizes a connector, we get their profile from that system

   ```typescript
   // During OAuth callback
   const profile = await graphClient.me.get();
   await createOrUpdateIdentityMapping({
     searchUserId: req.user.id,
     searchUserEmail: req.user.email,
     sourceType: 'sharepoint',
     sourceUserId: profile.id,
     sourceUserEmail: profile.mail,
     groups: await getSharePointGroups(profile.id),
     roles: [],
   });
   ```

2. **Sync Job**: Periodically refresh group memberships

   ```typescript
   // Daily job: Sync user groups for all connected users
   for (const mapping of activeUserMappings) {
     const groups = await connector.getUserGroups(mapping.sourceUserId);
     await updateIdentityMapping(mapping.searchUserId, { groups });
   }
   ```

3. **Admin Bulk Import**: For large orgs, admin can upload CSV mapping
   ```csv
   email,sharepoint_id,jira_account_id,servicenow_sys_id
   alice@company.com,alice-sp-guid,alice-jira-id,alice-snow-id
   ```

### 5.3 Query-Time Permission Enforcement

**Flow**:

1. User makes search request: `POST /api/search/:indexId/query`
2. Extract user from auth token: `req.user = { id: 'user123', email: 'alice@company.com' }`
3. Resolve user identities for all sources in this index:

   ```typescript
   const identities = await userIdentityResolver.resolve(req.user.id, indexId);
   // Returns: [
   //   { sourceType: 'sharepoint', userId: 'alice-sp-guid', groups: ['grp1', 'grp2'] },
   //   { sourceType: 'jira', userId: 'alice-jira-id', groups: [], roles: ['user'] }
   // ]
   ```

4. Build ACL filter for OpenSearch query:

   ```typescript
   const aclFilter = {
     bool: {
       should: [
         // Match if user is explicitly listed
         { terms: { acl_users: identities.map((i) => i.userId) } },

         // Match if any of user's groups are listed
         { terms: { acl_groups: identities.flatMap((i) => i.groups) } },

         // Match if any of user's roles are listed
         { terms: { acl_roles: identities.flatMap((i) => i.roles) } },

         // Match if document is public
         { term: { acl_visibility: 'public' } },

         // Match if document is authenticated and user is logged in
         { term: { acl_visibility: 'authenticated' } },
       ],
       minimum_should_match: 1,
     },
   };
   ```

5. Add ACL filter to main query:

   ```typescript
   const query = {
     bool: {
       must: [
         // Main vector/hybrid search
         { knn: { vector: embedding, k: 50 } },
       ],
       filter: [
         // Tenant isolation
         { term: { tenant_id: req.user.tenantId } },

         // Index filter
         { term: { index_id: indexId } },

         // ACL filter (CRITICAL)
         aclFilter,
       ],
     },
   };
   ```

6. Execute search and return only documents user can access

**Performance Optimization**:

- Cache user identities in Redis (5-minute TTL)
- Pre-expand groups at index time (denormalize) to avoid join
- Use OpenSearch filter cache for repeated ACL filters

---

## 6. User Identity & Activity Tracking

### 6.1 Activity Signals

Track user interactions to boost relevant documents:

```typescript
interface UserActivity {
  userId: string;
  documentId: string;
  sourceType: string;

  activities: {
    viewed: { count: number; lastAt: Date };
    edited: { count: number; lastAt: Date };
    commented: { count: number; lastAt: Date };
    shared: { count: number; lastAt: Date };
    starred: { count: number; lastAt: Date };
  };

  // Contextual signals
  viewDuration: number; // seconds
  scrollDepth: number; // percentage
  downloaded: boolean;

  // Time-based decay
  activityScore: number; // Weighted score with recency decay
  lastUpdated: Date;
}
```

**Sources of Activity**:

1. **Direct Tracking**: User views document in SearchAI UI
2. **Connector Sync**: Fetch activity logs from source systems
   - SharePoint: View analytics API
   - Jira: Issue history (user viewed, commented)
   - HubSpot: Engagement timeline
   - ServiceNow: Audit logs

**Activity Scoring**:

```typescript
function calculateActivityScore(activity: UserActivity): number {
  const weights = {
    viewed: 1,
    edited: 5,
    commented: 3,
    shared: 4,
    starred: 10,
  };

  let score = 0;
  const now = Date.now();

  for (const [type, data] of Object.entries(activity.activities)) {
    const daysSince = (now - data.lastAt.getTime()) / (1000 * 60 * 60 * 24);
    const recencyFactor = Math.exp(-0.1 * daysSince); // Exponential decay
    score += weights[type] * data.count * recencyFactor;
  }

  return score;
}
```

### 6.2 Relationship Graph

Track organizational relationships for collaborative filtering:

```typescript
interface UserRelationship {
  userId: string;

  relationships: {
    // Organizational hierarchy
    manager: string | null;
    directReports: string[];
    peers: string[]; // Same team/department

    // Collaboration signals
    frequentCollaborators: Array<{
      userId: string;
      collaborationScore: number; // Based on co-authoring, co-commenting, etc.
    }>;

    // Teams and groups
    teams: string[];
    departments: string[];
  };

  lastUpdated: Date;
}
```

**Sources**:

1. **HR System Integration**: Import org chart
2. **Source System Sync**:
   - SharePoint: Co-authors on documents
   - Jira: Co-assignees on issues, comment interactions
   - HubSpot: Team assignments, deal collaborators
   - ServiceNow: Assignment groups, watchers

**Query-Time Boosting**:

```typescript
// Boost documents authored/edited by user's manager or peers
const relationshipBoost = {
  function_score: {
    query: mainQuery,
    functions: [
      // Boost by 2x if authored by manager
      {
        filter: { term: { author_id: user.relationships.manager } },
        weight: 2.0,
      },
      // Boost by 1.5x if authored by direct report
      {
        filter: { terms: { author_id: user.relationships.directReports } },
        weight: 1.5,
      },
      // Boost by 1.3x if authored by peer
      {
        filter: { terms: { author_id: user.relationships.peers } },
        weight: 1.3,
      },
      // Boost by user's personal activity score
      {
        script_score: {
          script: {
            source: "doc['user_activity_scores'][params.userId] ?: 0",
            params: { userId: req.user.id },
          },
        },
      },
    ],
    score_mode: 'sum',
    boost_mode: 'multiply',
  },
};
```

### 6.3 Privacy & Compliance

**Principles**:

- ✅ **Data Minimization**: Only track activities needed for relevance
- ✅ **User Consent**: Opt-in for activity tracking (required for GDPR)
- ✅ **Right to Erasure**: User can request deletion of activity data
- ✅ **Transparency**: User can view what activities are tracked
- ✅ **Retention**: Auto-delete activity data older than 365 days (configurable)

**Implementation**:

```typescript
interface ActivityTrackingConsent {
  userId: string;
  consentGiven: boolean;
  consentDate: Date;
  dataRetentionDays: number; // Default 365
}

// Before tracking activity
if (!(await hasActivityTrackingConsent(userId))) {
  logger.warn(`Activity tracking disabled for user ${userId}`);
  return;
}

// Periodic cleanup job
async function cleanupOldActivity() {
  const cutoffDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  await UserActivity.deleteMany({ lastUpdated: { $lt: cutoffDate } });
}
```

---

## 7. Multi-Type Data Ingestion

### 7.1 Document Type Classification

Different document types require different processing strategies:

```typescript
enum DocumentType {
  // Files
  PDF = 'pdf',
  DOCX = 'docx',
  XLSX = 'xlsx',
  PPTX = 'pptx',
  IMAGE = 'image',
  VIDEO = 'video',

  // Structured Data
  ISSUE = 'issue', // Jira issue, ServiceNow incident
  TICKET = 'ticket', // Support ticket, request
  ARTICLE = 'article', // KB article, wiki page
  EMAIL = 'email',
  CONVERSATION = 'conversation', // Slack thread, Teams chat

  // CRM
  CONTACT = 'contact',
  COMPANY = 'company',
  DEAL = 'deal',

  // Code
  CODE_FILE = 'code',
  PULL_REQUEST = 'pr',

  // Other
  WEB_PAGE = 'webpage',
  CUSTOM = 'custom',
}
```

### 7.2 Type-Specific Chunking Strategies

**Strategy Matrix**:

| Document Type           | Chunking Approach                            | Chunk Size             | Special Handling                              |
| ----------------------- | -------------------------------------------- | ---------------------- | --------------------------------------------- |
| **PDF/DOCX**            | ATLAS-KG (hierarchical + semantic)           | 500-1000 tokens        | Extract tables separately, OCR for images     |
| **XLSX**                | Table-aware (preserve row/column structure)  | Per sheet or per table | Infer schema, keep headers with data          |
| **Jira Issue**          | Composite (description + comments + history) | Issue = 1 document     | Denormalize all comments into searchable text |
| **ServiceNow Incident** | Structured + activity log                    | Incident = 1 document  | Include work notes, related records           |
| **HubSpot Deal**        | Entity + relationships                       | Deal = 1 document      | Include associated contacts, company, emails  |
| **KB Article**          | Semantic sections                            | 300-500 tokens         | Preserve heading hierarchy                    |
| **Code File**           | Function/class level                         | Per function           | Include file path, import context             |

#### 7.2.1 File Document Chunking (PDF, DOCX, PPTX)

Use **ATLAS-KG** architecture (see `docs/searchai/ATLAS-KG-ARCHITECTURE.md`):

1. **Extract**: Parse with Docling
2. **Structure**: Build document tree (sections → paragraphs)
3. **Semantic Split**: Cluster similar paragraphs
4. **Chunk**: Create overlapping chunks with context
5. **Metadata**: Extract title, author, dates

#### 7.2.2 Spreadsheet Chunking (XLSX, CSV)

```typescript
interface TableChunk {
  chunkId: string;
  documentId: string;
  type: 'table';

  // Table structure
  headers: string[];
  rows: any[][];
  tableName: string;
  sheetName: string;

  // For semantic search
  textRepresentation: string; // "Header1: value1, Header2: value2, ..."
  summaryText: string; // LLM-generated summary of table content

  // Metadata
  rowCount: number;
  columnCount: number;
  dataTypes: Record<string, string>; // Inferred types per column
}
```

**Processing**:

1. Parse XLSX with `exceljs` or `xlsx` library
2. For each sheet:
   - Detect header row (first row with non-empty cells)
   - Infer data types (number, date, string)
   - Generate text representation: `"Name: Alice, Age: 30, Department: Engineering"`
   - Generate LLM summary: `"Employee data for Q4 2024 showing 50 engineering staff"`
3. Store both structured (rows/cols) and text representation
4. Index text representation in OpenSearch

#### 7.2.3 Issue/Ticket Chunking (Jira, ServiceNow)

```typescript
interface IssueDocument {
  documentId: string;
  type: 'issue';
  sourceType: 'jira' | 'servicenow';

  // Core fields
  key: string; // PROJ-123
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee: string;
  reporter: string;

  // Denormalized for search
  comments: Array<{
    author: string;
    body: string;
    createdAt: Date;
  }>;

  // Activity timeline
  history: Array<{
    field: string;
    from: string;
    to: string;
    changedBy: string;
    changedAt: Date;
  }>;

  // Relationships
  linkedIssues: string[];
  parentIssue: string | null;
  subtasks: string[];

  // For search
  fullText: string; // title + description + all comments concatenated

  // Attachments
  attachments: Array<{
    id: string;
    filename: string;
    contentType: string;
    extractedText?: string; // If attachment is indexable
  }>;
}
```

**Processing**:

1. Fetch issue with all comments and history
2. Denormalize: Create single document with all text
3. Extract attachments and process separately (linked to issue)
4. Index as single document (no chunking unless description >10k tokens)

#### 7.2.4 CRM Entity Chunking (HubSpot Deal, Contact, Company)

```typescript
interface CRMEntityDocument {
  documentId: string;
  type: 'deal' | 'contact' | 'company';
  sourceType: 'hubspot';

  // Entity data
  properties: Record<string, any>; // All HubSpot properties

  // Relationships
  associations: {
    contacts: string[];
    companies: string[];
    deals: string[];
  };

  // Activity timeline
  engagements: Array<{
    type: 'email' | 'call' | 'meeting' | 'note';
    timestamp: Date;
    subject: string;
    body: string;
    participants: string[];
  }>;

  // For search
  searchableText: string; // Concatenated: name, description, notes, email bodies
}
```

**Processing**:

1. Fetch entity with all properties
2. Fetch associated entities (denormalize for search)
3. Fetch engagement timeline
4. Generate searchable text representation
5. Index as single document

### 7.3 Chunking Pipeline

```typescript
interface ChunkingStrategy {
  name: string;

  shouldApply(doc: RawDocument): boolean;

  chunk(doc: RawDocument): Promise<Chunk[]>;
}

class ChunkingPipeline {
  private strategies: ChunkingStrategy[] = [
    new AtlasKGChunker(), // For PDFs, DOCX
    new TableChunker(), // For XLSX, CSV
    new IssueChunker(), // For Jira, ServiceNow
    new CRMEntityChunker(), // For HubSpot entities
    new CodeChunker(), // For code files
    new FallbackChunker(), // Generic text chunking
  ];

  async process(doc: RawDocument): Promise<Chunk[]> {
    for (const strategy of this.strategies) {
      if (strategy.shouldApply(doc)) {
        logger.info(`Using chunking strategy: ${strategy.name}`, { docId: doc.id });
        return await strategy.chunk(doc);
      }
    }

    throw new Error(`No chunking strategy found for document type: ${doc.type}`);
  }
}
```

---

## 8. Attachments Support

### 8.1 Problem Statement

**Challenge**: Attachments can appear in multiple contexts across different connectors:

1. **Jira**: Issues can have attachments, comments can have attachments
2. **Confluence**: Pages have inline attachments (images via macros) and regular attachments
3. **SharePoint**: Files themselves are the primary content, but also version attachments
4. **ServiceNow**: Incidents and KB articles can have attachments
5. **HubSpot**: Emails in engagement timeline can have attachments

**Requirements**:

- ✅ Extract and index attachment content (PDFs, DOCX, images with OCR)
- ✅ Maintain relationship between attachment and parent (e.g., PDF attached to Jira comment)
- ✅ Apply permissions from parent to attachment
- ✅ Support search across both parent content and attachments
- ✅ Handle large attachments (>100MB) without blocking pipeline
- ✅ Deduplicate attachments (same file attached to multiple places)

### 8.2 Attachment Data Model

```typescript
interface Attachment {
  attachmentId: string;
  tenantId: string;

  // Parent relationship
  parentDocumentId: string; // Issue, page, incident, etc.
  parentDocumentType: 'issue' | 'page' | 'incident' | 'email' | 'comment';
  parentSourceId: string; // ID in source system

  // Attachment metadata
  filename: string;
  contentType: string; // MIME type
  sizeBytes: number;
  sourceAttachmentId: string; // ID in source system
  sourceUrl: string; // URL to download from source

  // Extracted content
  extractedText: string | null; // For PDFs, DOCX, etc.
  ocrText: string | null; // For images
  thumbnailUrl: string | null;

  // Processing status
  processingStatus: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  processingError: string | null;
  processedAt: Date | null;

  // Deduplication
  contentHash: string; // SHA-256 of content
  isDuplicate: boolean;
  originalAttachmentId: string | null; // If duplicate, points to original

  // Permissions (inherited from parent)
  acl: {
    users: string[];
    groups: string[];
    roles: string[];
    visibility: string;
  };

  // Source tracking
  sourceType: string;
  connectorId: string;

  createdAt: Date;
  updatedAt: Date;
}
```

### 8.3 Attachment Extraction Pipeline

```typescript
class AttachmentProcessor {
  async processAttachment(
    attachment: Attachment,
    parentPermissions: DocumentPermissions,
  ): Promise<ProcessedAttachment> {
    // 1. Check if already processed (deduplication)
    const existing = await this.findByContentHash(attachment.contentHash);
    if (existing) {
      logger.info(`Attachment already processed, linking to existing`, {
        attachmentId: attachment.attachmentId,
        originalId: existing.attachmentId,
      });

      return {
        ...attachment,
        isDuplicate: true,
        originalAttachmentId: existing.attachmentId,
        extractedText: existing.extractedText,
      };
    }

    // 2. Download attachment content
    const content = await this.downloadAttachment(attachment.sourceUrl);

    // 3. Extract text based on content type
    let extractedText: string | null = null;
    let ocrText: string | null = null;

    switch (attachment.contentType) {
      case 'application/pdf':
        extractedText = await this.extractFromPDF(content);
        break;

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      case 'application/msword':
        extractedText = await this.extractFromDOCX(content);
        break;

      case 'image/png':
      case 'image/jpeg':
      case 'image/gif':
        ocrText = await this.extractWithOCR(content);
        break;

      case 'text/plain':
      case 'text/html':
        extractedText = content.toString('utf-8');
        break;

      default:
        logger.warn(`Unsupported content type for extraction`, {
          contentType: attachment.contentType,
          filename: attachment.filename,
        });
    }

    // 4. Inherit permissions from parent
    const acl = parentPermissions.acl;

    // 5. Store attachment record
    await this.saveAttachment({
      ...attachment,
      extractedText,
      ocrText,
      acl,
      processingStatus: 'completed',
      processedAt: new Date(),
    });

    // 6. Index attachment content
    if (extractedText || ocrText) {
      await this.indexAttachment({
        attachmentId: attachment.attachmentId,
        parentDocumentId: attachment.parentDocumentId,
        filename: attachment.filename,
        content: extractedText || ocrText,
        acl,
      });
    }

    return attachment;
  }

  private async extractFromPDF(content: Buffer): Promise<string> {
    // Use pdf-parse or Docling
    const pdfData = await pdfParse(content);
    return pdfData.text;
  }

  private async extractFromDOCX(content: Buffer): Promise<string> {
    // Use mammoth or docx library
    const result = await mammoth.extractRawText({ buffer: content });
    return result.value;
  }

  private async extractWithOCR(content: Buffer): Promise<string> {
    // Use Tesseract or Azure Vision API
    const text = await tesseract.recognize(content);
    return text;
  }
}
```

### 8.4 Connector-Specific Attachment Handling

#### 8.4.1 Jira Attachments

**Challenge**: Attachments can be on issues OR on comments.

```typescript
class JiraConnector implements IConnector {
  async fetchIssueWithAttachments(issueKey: string): Promise<IssueDocument> {
    // Fetch issue
    const issue = await this.jiraClient.getIssue(issueKey, {
      expand: 'attachment,comment',
    });

    const attachments: Attachment[] = [];

    // 1. Issue-level attachments
    for (const attachment of issue.fields.attachment || []) {
      attachments.push({
        attachmentId: uuidv7(),
        parentDocumentId: issue.key,
        parentDocumentType: 'issue',
        parentSourceId: issue.key,
        filename: attachment.filename,
        contentType: attachment.mimeType,
        sizeBytes: attachment.size,
        sourceAttachmentId: attachment.id,
        sourceUrl: attachment.content,
        sourceType: 'jira',
        contentHash: await this.calculateHash(attachment.content),
      });
    }

    // 2. Comment attachments (less common but possible)
    for (const comment of issue.fields.comment?.comments || []) {
      // Check if comment has inline attachments
      const attachmentRefs = this.extractAttachmentReferences(comment.body);

      for (const ref of attachmentRefs) {
        const attachmentData = await this.jiraClient.getAttachment(ref.id);
        attachments.push({
          attachmentId: uuidv7(),
          parentDocumentId: comment.id,
          parentDocumentType: 'comment',
          parentSourceId: comment.id,
          filename: attachmentData.filename,
          contentType: attachmentData.mimeType,
          sizeBytes: attachmentData.size,
          sourceAttachmentId: attachmentData.id,
          sourceUrl: attachmentData.content,
          sourceType: 'jira',
          contentHash: await this.calculateHash(attachmentData.content),
        });
      }
    }

    return { issue, attachments };
  }

  // Extract attachment references from comment markdown
  // Example: !image.png! or [^attachment.pdf]
  private extractAttachmentReferences(text: string): Array<{ id: string; type: string }> {
    const imagePattern = /!([^!]+)!/g;
    const filePattern = /\[\^([^\]]+)\]/g;

    const refs: Array<{ id: string; type: string }> = [];

    // ... parsing logic

    return refs;
  }
}
```

#### 8.4.2 Confluence Attachments

**Challenge**: Inline attachments (images embedded in page via macros) vs regular attachments.

```typescript
class ConfluenceConnector implements IConnector {
  async fetchPageWithAttachments(pageId: string): Promise<PageDocument> {
    // Fetch page
    const page = await this.confluenceClient.getPage(pageId, {
      expand: 'body.storage,version,space',
    });

    const attachments: Attachment[] = [];

    // 1. Regular attachments
    const attachmentList = await this.confluenceClient.getAttachments(pageId);
    for (const attachment of attachmentList.results) {
      attachments.push({
        attachmentId: uuidv7(),
        parentDocumentId: pageId,
        parentDocumentType: 'page',
        parentSourceId: pageId,
        filename: attachment.title,
        contentType: attachment.metadata.mediaType,
        sizeBytes: attachment.extensions.fileSize,
        sourceAttachmentId: attachment.id,
        sourceUrl: attachment._links.download,
        sourceType: 'confluence',
        contentHash: await this.calculateHash(attachment._links.download),
      });
    }

    // 2. Inline attachments (from <ac:image> macros)
    const inlineAttachments = this.extractInlineAttachments(page.body.storage.value);
    for (const inline of inlineAttachments) {
      // Fetch attachment details
      const attachmentData = await this.confluenceClient.getAttachment(inline.filename, pageId);

      attachments.push({
        attachmentId: uuidv7(),
        parentDocumentId: pageId,
        parentDocumentType: 'page',
        parentSourceId: pageId,
        filename: inline.filename,
        contentType: attachmentData.metadata.mediaType,
        sizeBytes: attachmentData.extensions.fileSize,
        sourceAttachmentId: attachmentData.id,
        sourceUrl: attachmentData._links.download,
        sourceType: 'confluence',
        isInline: true, // Mark as inline
        contentHash: await this.calculateHash(attachmentData._links.download),
      });
    }

    return { page, attachments };
  }

  // Extract inline attachments from Confluence storage format
  // Example: <ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>
  private extractInlineAttachments(storageHtml: string): Array<{ filename: string }> {
    const attachments: Array<{ filename: string }> = [];

    const imagePattern = /<ri:attachment ri:filename="([^"]+)"[^>]*>/g;
    let match;

    while ((match = imagePattern.exec(storageHtml)) !== null) {
      attachments.push({ filename: match[1] });
    }

    return attachments;
  }
}
```

#### 8.4.3 ServiceNow Attachments

```typescript
class ServiceNowConnector implements IConnector {
  async fetchIncidentWithAttachments(incidentId: string): Promise<IncidentDocument> {
    // Fetch incident
    const incident = await this.snowClient.get(`/api/now/table/incident/${incidentId}`);

    // Fetch attachments
    const attachmentQuery = `table_name=incident^table_sys_id=${incidentId}`;
    const attachmentList = await this.snowClient.get(
      `/api/now/attachment?sysparm_query=${attachmentQuery}`,
    );

    const attachments: Attachment[] = [];

    for (const attachment of attachmentList.result) {
      attachments.push({
        attachmentId: uuidv7(),
        parentDocumentId: incidentId,
        parentDocumentType: 'incident',
        parentSourceId: incidentId,
        filename: attachment.file_name,
        contentType: attachment.content_type,
        sizeBytes: parseInt(attachment.size_bytes),
        sourceAttachmentId: attachment.sys_id,
        sourceUrl: `${this.baseUrl}/api/now/attachment/${attachment.sys_id}/file`,
        sourceType: 'servicenow',
        contentHash: attachment.hash, // ServiceNow provides MD5 hash
      });
    }

    return { incident, attachments };
  }
}
```

### 8.5 Attachment Search Integration

**Search across both parent and attachments**:

```typescript
async function searchWithAttachments(
  query: string,
  userId: string,
  indexId: string,
): Promise<SearchResult> {
  // Build query that searches both documents and attachments
  const opensearchQuery = {
    bool: {
      should: [
        // Search in main document content
        {
          multi_match: {
            query,
            fields: ['title^3', 'content^2', 'summary'],
          },
        },

        // Search in attachment content
        {
          nested: {
            path: 'attachments',
            query: {
              multi_match: {
                query,
                fields: ['attachments.filename^2', 'attachments.extractedText'],
              },
            },
          },
        },
      ],
    },
  };

  // Execute search
  const results = await opensearchClient.search({
    index: indexId,
    body: { query: opensearchQuery },
  });

  // Format results
  return results.hits.hits.map((hit) => ({
    documentId: hit._id,
    title: hit._source.title,
    snippet: hit._source.content.substring(0, 200),
    attachments: hit._source.attachments || [],
    score: hit._score,
  }));
}
```

### 8.6 Attachment Deduplication

**Problem**: Same PDF attached to multiple Jira issues shouldn't be processed multiple times.

```typescript
class AttachmentDeduplicator {
  private redis: RedisClient;

  async checkDuplicate(contentHash: string): Promise<Attachment | null> {
    // Check cache first
    const cached = await this.redis.get(`attachment:hash:${contentHash}`);
    if (cached) {
      return JSON.parse(cached);
    }

    // Check database
    const existing = await Attachment.findOne({ contentHash });

    if (existing) {
      // Cache for 1 hour
      await this.redis.setex(`attachment:hash:${contentHash}`, 3600, JSON.stringify(existing));
    }

    return existing;
  }

  async processWithDeduplication(attachment: Attachment): Promise<void> {
    const duplicate = await this.checkDuplicate(attachment.contentHash);

    if (duplicate) {
      // Link to existing attachment
      await this.createAttachmentLink({
        newAttachmentId: attachment.attachmentId,
        originalAttachmentId: duplicate.attachmentId,
        parentDocumentId: attachment.parentDocumentId,
      });

      logger.info(`Deduplicated attachment`, {
        newId: attachment.attachmentId,
        originalId: duplicate.attachmentId,
        filename: attachment.filename,
      });
    } else {
      // Process as new attachment
      await this.processAttachment(attachment);
    }
  }
}
```

### 8.7 Large Attachment Handling

**Problem**: 200MB PDF shouldn't block the entire sync job.

```typescript
class LargeAttachmentHandler {
  private readonly SIZE_THRESHOLD = 100 * 1024 * 1024; // 100MB

  async handleAttachment(attachment: Attachment): Promise<void> {
    if (attachment.sizeBytes > this.SIZE_THRESHOLD) {
      // Enqueue for async processing
      await attachmentQueue.add(
        'process-large-attachment',
        {
          attachmentId: attachment.attachmentId,
        },
        {
          priority: 'low',
          timeout: 600000, // 10 minutes
        },
      );

      logger.info(`Large attachment queued for async processing`, {
        attachmentId: attachment.attachmentId,
        sizeBytes: attachment.sizeBytes,
        filename: attachment.filename,
      });
    } else {
      // Process inline
      await this.processAttachment(attachment);
    }
  }
}
```

### 8.8 Attachment Metrics

```typescript
// Prometheus metrics
counter('searchai_attachments_processed', 'Total attachments processed', [
  'source_type',
  'content_type',
]);
counter('searchai_attachments_failed', 'Attachments that failed processing', [
  'source_type',
  'failure_reason',
]);
counter('searchai_attachments_deduplicated', 'Attachments deduplicated', ['source_type']);
histogram('searchai_attachment_processing_duration', 'Attachment processing duration', [
  'content_type',
]);
gauge('searchai_attachment_queue_depth', 'Attachments waiting for processing');
```

---

## 9. Selective Data Ingestion & Filtering

### 9.1 Problem Statement

**Challenge**: Users don't want to index everything from a source system. Common needs:

1. **Project-based filtering**: "Only index projects A, B, C from Jira"
2. **Date-based filtering**: "Only index documents modified in the last 90 days"
3. **Label/tag filtering**: "Only index Confluence pages with label 'public'"
4. **Status filtering**: "Only index open and in-progress Jira issues"
5. **Size filtering**: "Skip files larger than 100MB"
6. **Type filtering**: "Only index PDFs and DOCX, skip images"
7. **Location filtering**: "Only specific SharePoint sites or Confluence spaces"
8. **Custom field filtering**: "Only Jira issues where custom field 'Department' = 'Engineering'"

**Why This Matters**:

- **Cost**: Reduces storage and indexing costs by 50-90%
- **Performance**: Faster sync and search with smaller index
- **Relevance**: Users only search relevant content
- **Compliance**: Exclude sensitive or regulated content

### 9.2 Filter Configuration Model

```typescript
interface ConnectorFilterConfig {
  connectorId: string;
  enabled: boolean;

  // Pre-defined filters (common across connectors)
  commonFilters: {
    // Date-based
    modifiedAfter?: Date;
    modifiedBefore?: Date;
    createdAfter?: Date;
    createdBefore?: Date;

    // Size-based
    minSizeBytes?: number;
    maxSizeBytes?: number;

    // Type-based (MIME types or file extensions)
    includeContentTypes?: string[]; // ['application/pdf', 'text/plain']
    excludeContentTypes?: string[];
    includeFileExtensions?: string[]; // ['.pdf', '.docx', '.txt']
    excludeFileExtensions?: string[]; // ['.zip', '.exe']

    // Status-based (for issues/tickets)
    includeStatuses?: string[]; // ['Open', 'In Progress', 'Resolved']
    excludeStatuses?: string[]; // ['Closed', 'Cancelled']

    // User-based
    includeAuthors?: string[]; // Only documents by these authors
    excludeAuthors?: string[];
  };

  // Source-specific filters
  sourceSpecificFilters: Record<string, any>;
}
```

### 9.3 Connector-Specific Filter Examples

#### 9.3.1 Jira Filters

```typescript
interface JiraFilterConfig {
  // Project filtering
  includeProjects?: string[]; // ['PROJ', 'ENG', 'DESIGN']
  excludeProjects?: string[];

  // Issue type filtering
  includeIssueTypes?: string[]; // ['Bug', 'Story', 'Epic']
  excludeIssueTypes?: string[]; // ['Sub-task']

  // Status filtering
  includeStatuses?: string[]; // ['Open', 'In Progress']
  excludeStatuses?: string[]; // ['Done', 'Closed']

  // Label filtering
  includeLabels?: string[]; // ['customer-facing', 'high-priority']
  excludeLabels?: string[]; // ['internal-only']

  // Priority filtering
  includePriorities?: string[]; // ['Highest', 'High']

  // Assignee filtering
  includeAssignees?: string[]; // ['user@company.com']
  unassignedOnly?: boolean;

  // Custom JQL (advanced)
  customJQL?: string; // 'project = ENG AND priority >= High AND created >= -90d'

  // Component filtering
  includeComponents?: string[];
  excludeComponents?: string[];

  // Version filtering
  includeFixVersions?: string[];
  includeAffectsVersions?: string[];
}
```

**Example Configuration**:

```json
{
  "connectorId": "conn_jira_prod",
  "enabled": true,
  "commonFilters": {
    "modifiedAfter": "2024-01-01T00:00:00Z"
  },
  "sourceSpecificFilters": {
    "includeProjects": ["ENG", "DESIGN"],
    "includeStatuses": ["Open", "In Progress", "Code Review"],
    "excludeIssueTypes": ["Sub-task"],
    "includeLabels": ["customer-facing"]
  }
}
```

#### 9.3.2 Confluence Filters

```typescript
interface ConfluenceFilterConfig {
  // Space filtering
  includeSpaces?: string[]; // ['ENG', 'PRODUCT', 'DESIGN']
  excludeSpaces?: string[];

  // Label filtering
  includeLabels?: string[]; // ['public', 'documentation']
  excludeLabels?: string[]; // ['draft', 'deprecated']

  // Content type filtering
  includeContentTypes?: ('page' | 'blogpost' | 'comment')[]; // ['page']

  // Status filtering
  includeCurrent?: boolean; // Only current versions (not archived)
  includeArchived?: boolean;

  // Ancestor filtering (page hierarchy)
  ancestorPageIds?: string[]; // Only pages under these ancestors

  // CQL (Confluence Query Language)
  customCQL?: string; // 'space = ENG AND label = public AND created >= now("-90d")'
}
```

**Example Configuration**:

```json
{
  "connectorId": "conn_confluence_wiki",
  "enabled": true,
  "commonFilters": {
    "modifiedAfter": "2024-01-01T00:00:00Z",
    "maxSizeBytes": 104857600
  },
  "sourceSpecificFilters": {
    "includeSpaces": ["ENG", "PRODUCT"],
    "includeLabels": ["public"],
    "includeContentTypes": ["page"],
    "includeCurrent": true
  }
}
```

#### 9.3.3 SharePoint Filters

```typescript
interface SharePointFilterConfig {
  // Site filtering
  includeSites?: string[]; // ['Corporate Intranet', 'Engineering Hub']
  excludeSites?: string[];

  // Library/List filtering
  includeLibraries?: string[]; // ['Documents', 'Shared Documents']
  excludeLibraries?: string[]; // ['Form Templates']

  // Folder path filtering
  includeFolderPaths?: string[]; // ['/sites/eng/Shared Documents/Public']
  excludeFolderPaths?: string[]; // ['/sites/eng/Shared Documents/Archive']

  // Content type filtering
  includeContentTypes?: string[]; // ['Document', 'Page']
  excludeContentTypes?: string[]; // ['Folder']

  // Metadata filtering
  metadataFilters?: Array<{
    field: string;
    operator: 'equals' | 'contains' | 'startsWith';
    value: string;
  }>;
  // Example: [{ field: 'Department', operator: 'equals', value: 'Engineering' }]
}
```

#### 9.3.4 ServiceNow Filters

```typescript
interface ServiceNowFilterConfig {
  // Table filtering
  includeTables?: string[]; // ['incident', 'problem', 'kb_knowledge']
  excludeTables?: string[];

  // Status filtering (per table)
  incidentStatuses?: string[]; // ['New', 'In Progress', 'Resolved']
  problemStatuses?: string[];

  // Category filtering
  includeCategories?: string[]; // ['Software', 'Hardware']
  excludeCategories?: string[];

  // Assignment group filtering
  includeAssignmentGroups?: string[]; // ['Engineering', 'DevOps']

  // Priority filtering
  includePriorities?: string[]; // ['1 - Critical', '2 - High']

  // Custom query
  customQuery?: string; // 'active=true^priority<=2^sys_updated_on>=javascript:gs.daysAgo(90)'
}
```

#### 9.3.5 HubSpot Filters

```typescript
interface HubSpotFilterConfig {
  // Object type filtering
  includeObjectTypes?: ('contact' | 'company' | 'deal' | 'ticket' | 'email')[]; // ['deal', 'ticket']

  // Deal stage filtering
  includeDealStages?: string[]; // ['qualifiedtobuy', 'presentationscheduled']
  excludeDealStages?: string[]; // ['closedlost']

  // Pipeline filtering
  includePipelines?: string[]; // ['default', 'sales']

  // Owner filtering
  includeOwners?: string[]; // ['owner@company.com']

  // Property filtering
  propertyFilters?: Array<{
    property: string;
    operator: 'EQ' | 'NEQ' | 'LT' | 'GT' | 'CONTAINS';
    value: string;
  }>;
  // Example: [{ property: 'amount', operator: 'GT', value: '10000' }]
}
```

### 9.4 Filter Application During Sync

```typescript
class FilteredSyncExecutor {
  async syncWithFilters(
    connector: IConnector,
    filterConfig: ConnectorFilterConfig,
  ): Promise<SyncResult> {
    if (!filterConfig.enabled) {
      // No filters, sync everything
      return await this.syncAll(connector);
    }

    // Build filter query
    const query = this.buildFilterQuery(connector, filterConfig);

    logger.info(`Starting filtered sync`, {
      connectorId: connector.id,
      filters: query,
    });

    // Fetch filtered documents
    const documents = await connector.listDocuments({ filter: query });

    let processed = 0;
    let skipped = 0;

    for (const doc of documents) {
      // Apply client-side filters (if source API doesn't support all filters)
      if (!this.passesFilters(doc, filterConfig)) {
        skipped++;
        logger.debug(`Document skipped by filters`, {
          documentId: doc.id,
          reason: this.getSkipReason(doc, filterConfig),
        });
        continue;
      }

      // Process document
      await this.processDocument(doc);
      processed++;
    }

    return { processed, skipped };
  }

  private buildFilterQuery(connector: IConnector, filterConfig: ConnectorFilterConfig): any {
    switch (connector.sourceType) {
      case 'jira':
        return this.buildJiraJQL(filterConfig);
      case 'confluence':
        return this.buildConfluenceCQL(filterConfig);
      case 'sharepoint':
        return this.buildSharePointQuery(filterConfig);
      // ... other connectors
    }
  }

  private buildJiraJQL(filterConfig: ConnectorFilterConfig): string {
    const clauses: string[] = [];
    const jiraFilters = filterConfig.sourceSpecificFilters as JiraFilterConfig;

    // Project filter
    if (jiraFilters.includeProjects?.length) {
      clauses.push(`project IN (${jiraFilters.includeProjects.join(',')})`);
    }

    // Status filter
    if (jiraFilters.includeStatuses?.length) {
      clauses.push(`status IN (${jiraFilters.includeStatuses.map((s) => `"${s}"`).join(',')})`);
    }

    // Date filter
    if (filterConfig.commonFilters.modifiedAfter) {
      const date = filterConfig.commonFilters.modifiedAfter.toISOString().split('T')[0];
      clauses.push(`updated >= "${date}"`);
    }

    // Label filter
    if (jiraFilters.includeLabels?.length) {
      clauses.push(`labels IN (${jiraFilters.includeLabels.join(',')})`);
    }

    // Custom JQL (highest priority)
    if (jiraFilters.customJQL) {
      return jiraFilters.customJQL;
    }

    return clauses.join(' AND ');
  }

  private passesFilters(doc: any, filterConfig: ConnectorFilterConfig): boolean {
    // Common filters (applied client-side if not supported by API)

    // Size filter
    if (filterConfig.commonFilters.maxSizeBytes) {
      if (doc.sizeBytes > filterConfig.commonFilters.maxSizeBytes) {
        return false;
      }
    }

    // Content type filter
    if (filterConfig.commonFilters.excludeContentTypes?.length) {
      if (filterConfig.commonFilters.excludeContentTypes.includes(doc.contentType)) {
        return false;
      }
    }

    // File extension filter
    if (filterConfig.commonFilters.excludeFileExtensions?.length) {
      const ext = this.getFileExtension(doc.filename);
      if (filterConfig.commonFilters.excludeFileExtensions.includes(ext)) {
        return false;
      }
    }

    return true;
  }
}
```

### 9.5 Filter UI/UX

**Admin Configuration UI**:

```
┌──────────────────────────────────────────────────────────────────┐
│ Configure Sync Filters: Jira Production                         │
├──────────────────────────────────────────────────────────────────┤
│ ☑ Enable Filtering                                              │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Common Filters                                              │  │
│ ├────────────────────────────────────────────────────────────┤  │
│ │ Modified After: [2024-01-01       ] 📅                     │  │
│ │ Max File Size:  [100              ] MB                      │  │
│ │                                                             │  │
│ │ Exclude File Types:                                         │  │
│ │ ☑ .zip  ☑ .exe  ☑ .dmg  ☐ .iso                            │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Jira-Specific Filters                                       │  │
│ ├────────────────────────────────────────────────────────────┤  │
│ │ Projects:                                                   │  │
│ │ [+] ENG          [×]                                        │  │
│ │ [+] DESIGN       [×]                                        │  │
│ │ [+] PRODUCT      [×]                                        │  │
│ │ [Add Project...]                                            │  │
│ │                                                             │  │
│ │ Issue Types:                                                │  │
│ │ ☑ Bug  ☑ Story  ☑ Epic  ☐ Sub-task  ☐ Task                │  │
│ │                                                             │  │
│ │ Statuses:                                                   │  │
│ │ ☑ Open  ☑ In Progress  ☑ Code Review  ☐ Done  ☐ Closed    │  │
│ │                                                             │  │
│ │ Labels (Include):                                           │  │
│ │ [customer-facing] [+]  [high-priority] [+]                  │  │
│ │                                                             │  │
│ │ Custom JQL (Advanced):                                      │  │
│ │ [ project IN (ENG, DESIGN) AND priority >= High       ]    │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ Preview: ~5,234 issues will be synced                           │
│ Estimated Savings: 68% fewer documents                          │
│                                                                  │
│ [Test Query] [Reset] [Save Filters]                             │
└──────────────────────────────────────────────────────────────────┘
```

### 9.6 Filter Testing & Preview

```typescript
// API endpoint to test filters without syncing
router.post('/api/connectors/:connectorId/filters/test', async (req, res) => {
  const { connectorId } = req.params;
  const filterConfig: ConnectorFilterConfig = req.body;

  const connector = await getConnector(connectorId);

  // Build query from filters
  const query = buildFilterQuery(connector, filterConfig);

  // Fetch sample (first 100 documents)
  const sample = await connector.listDocuments({
    filter: query,
    limit: 100,
  });

  // Estimate total count (if API supports it)
  const totalCount = await connector.countDocuments({ filter: query });

  res.json({
    query, // Show user the generated query
    sampleDocuments: sample.documents.map((d) => ({
      id: d.id,
      title: d.title,
      type: d.type,
      modifiedAt: d.modifiedAt,
    })),
    estimatedTotalDocuments: totalCount,
    savingsPercent: calculateSavings(totalCount, connector.totalDocuments),
  });
});
```

### 9.7 Filter Metrics

```typescript
// Prometheus metrics
counter('searchai_sync_documents_filtered', 'Documents filtered out', [
  'connector_id',
  'filter_type',
]);
gauge('searchai_connector_filter_efficiency', 'Filter efficiency %', ['connector_id']);
histogram('searchai_filter_query_duration', 'Filter query duration', ['connector_id']);
```

### 9.8 Best Practices

**For Administrators**:

1. Start broad, then refine filters based on user feedback
2. Test filters before applying to production sync
3. Monitor "Documents Filtered" metric to validate filters are working
4. Use date-based filters (e.g., last 90 days) for initial sync, then switch to incremental

**For Connectors**:

1. Push filters to API when possible (server-side filtering is faster)
2. Fall back to client-side filtering if API doesn't support certain filters
3. Log filter effectiveness (% of documents skipped)
4. Validate filter syntax before sync starts

---

## 10. Configurable Permission Crawling & OAuth Scopes

### 10.1 Problem Statement

**Challenge**: Permission crawling can be expensive:

1. **API Calls**: Each document requires separate permission API call
   - SharePoint: `GET /sites/{site}/items/{id}/permissions` (1 call per document)
   - Jira: Permission scheme evaluation (multiple calls for nested permissions)
   - Confluence: Space + page permissions (2 calls per page)

2. **Rate Limits**: Permission APIs often have stricter rate limits
   - Example: SharePoint Graph API has separate throttling for permissions

3. **Performance**: Permission crawling adds 200-500ms per document
   - 10,000 documents = 30-90 minutes just for permissions

4. **Use Case**: Not all deployments need per-document permissions
   - **Public knowledge base**: Everything is public, no need for permissions
   - **Single-tenant**: All users have access to everything
   - **Trusted environment**: Query-time permission checking not required

**Solution**: Make permission crawling optional and configurable.

### 10.2 Permission Configuration Model

```typescript
interface PermissionCrawlingConfig {
  connectorId: string;

  // Global toggle
  enabled: boolean; // Default: true

  // Granular controls
  mode: 'full' | 'simplified' | 'disabled';

  // Full mode: Crawl permissions for every document
  fullModeConfig?: {
    includeGroups: boolean; // Expand groups to users (expensive)
    includeInheritance: boolean; // Traverse inheritance chain
    cachePermissions: boolean; // Cache permission results
    cacheTTL: number; // Cache TTL in seconds (default 300)
  };

  // Simplified mode: Use heuristics to reduce API calls
  simplifiedModeConfig?: {
    assumeInheritance: boolean; // Assume most documents inherit from parent
    onlyCheckParentPermissions: boolean; // Only check container (site/space/project) permissions
    sampleRate: number; // 0-1, sample X% of documents for full permission check
  };

  // Disabled mode: No permission crawling
  disabledModeConfig?: {
    defaultVisibility: 'public' | 'authenticated' | 'private'; // Default visibility for all documents
    staticACL?: {
      users: string[];
      groups: string[];
      roles: string[];
    };
  };

  // Performance settings
  performanceConfig: {
    maxConcurrentPermissionCalls: number; // Default: 5
    permissionCallTimeoutMs: number; // Default: 5000
    skipPermissionsOnTimeout: boolean; // If true, mark as public on timeout
  };
}
```

### 10.3 Permission Modes

#### 10.3.1 Full Mode (Default)

**When to Use**: Production environments with sensitive data.

```typescript
{
  "connectorId": "conn_sharepoint_prod",
  "enabled": true,
  "mode": "full",
  "fullModeConfig": {
    "includeGroups": true,
    "includeInheritance": true,
    "cachePermissions": true,
    "cacheTTL": 300
  }
}
```

**Characteristics**:

- ✅ Most secure: Every document's permissions are checked
- ✅ Accurate: Handles complex inheritance and group membership
- ❌ Slowest: 200-500ms per document
- ❌ Most expensive: Consumes most API quota

#### 10.3.2 Simplified Mode

**When to Use**: Most documents inherit permissions, only exceptions need checking.

```typescript
{
  "connectorId": "conn_confluence_wiki",
  "enabled": true,
  "mode": "simplified",
  "simplifiedModeConfig": {
    "assumeInheritance": true,
    "onlyCheckParentPermissions": true,
    "sampleRate": 0.1 // Check 10% of documents, assume rest inherit
  }
}
```

**Characteristics**:

- ✅ Faster: Only checks space/project/site permissions
- ✅ Lower cost: 90% fewer API calls
- ⚠️ Less accurate: May miss documents with unique permissions
- ⚠️ Best for: Systems where most content inherits permissions

**Implementation**:

```typescript
async function fetchPermissionsSimplified(
  document: Document,
  config: SimplifiedModeConfig,
): Promise<DocumentPermissions> {
  // Check if this document should be sampled
  const shouldSample = Math.random() < config.sampleRate;

  if (shouldSample || !config.assumeInheritance) {
    // Full permission check
    return await connector.getDocumentPermissions(document.id);
  }

  // Assume inherited, check parent only
  const parent = await getParentContainer(document); // Space, site, project
  const parentPermissions = await connector.getDocumentPermissions(parent.id);

  return {
    ...parentPermissions,
    documentId: document.id,
    inheritedFrom: parent.id,
  };
}
```

#### 10.3.3 Disabled Mode

**When to Use**: Public knowledge bases, trusted internal tools, demo environments.

```typescript
{
  "connectorId": "conn_public_docs",
  "enabled": false,
  "mode": "disabled",
  "disabledModeConfig": {
    "defaultVisibility": "public"
  }
}
```

**Characteristics**:

- ✅ Fastest: Zero permission API calls
- ✅ Cheapest: No API quota consumed
- ❌ Least secure: All documents treated the same
- ❌ Best for: Public content only

**Implementation**:

```typescript
async function fetchPermissionsDisabled(
  document: Document,
  config: DisabledModeConfig,
): Promise<DocumentPermissions> {
  // Return static permissions
  return {
    documentId: document.id,
    sourceType: connector.sourceType,
    sourceDocumentId: document.sourceId,
    acl: config.staticACL || {
      users: [],
      groups: [],
      roles: [],
      visibility: config.defaultVisibility,
    },
    lastSyncedAt: new Date(),
    permissionVersion: 1,
  };
}
```

### 10.4 Permission Crawling in Sync Pipeline

```typescript
class PermissionAwareSync Executor {
  async syncDocument(
    document: Document,
    permissionConfig: PermissionCrawlingConfig
  ): Promise<void> {

    // 1. Extract content
    const content = await this.extractContent(document);

    // 2. Chunk content
    const chunks = await this.chunkContent(content);

    // 3. Fetch permissions (configurable)
    let permissions: DocumentPermissions;

    if (!permissionConfig.enabled || permissionConfig.mode === 'disabled') {
      // No permission crawling
      permissions = this.getStaticPermissions(permissionConfig.disabledModeConfig);
      logger.debug(`Using static permissions (disabled mode)`, { documentId: document.id });
    } else if (permissionConfig.mode === 'simplified') {
      // Simplified permission crawling
      permissions = await this.fetchPermissionsSimplified(
        document,
        permissionConfig.simplifiedModeConfig
      );
      logger.debug(`Using simplified permissions`, { documentId: document.id });
    } else {
      // Full permission crawling
      try {
        permissions = await timeout(
          this.connector.getDocumentPermissions(document.id),
          permissionConfig.performanceConfig.permissionCallTimeoutMs
        );
      } catch (error) {
        if (error.name === 'TimeoutError') {
          logger.warn(`Permission fetch timeout`, { documentId: document.id });

          if (permissionConfig.performanceConfig.skipPermissionsOnTimeout) {
            // Fallback to public
            permissions = this.getPublicPermissions(document.id);
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }

    // 4. Apply permissions to chunks
    for (const chunk of chunks) {
      chunk.acl = permissions.acl;
    }

    // 5. Index chunks
    await this.indexChunks(chunks);
  }
}
```

### 10.5 UI Configuration

```
┌──────────────────────────────────────────────────────────────────┐
│ Permission Crawling Settings: Confluence Wiki                    │
├──────────────────────────────────────────────────────────────────┤
│ ☑ Enable Permission Crawling                                    │
│                                                                  │
│ Mode:                                                            │
│ ⦿ Full (Most secure, slowest)                                   │
│   • Checks permissions for every document                        │
│   • ~500ms per document                                         │
│   • Recommended for production with sensitive data              │
│                                                                  │
│ ○ Simplified (Balanced)                                          │
│   • Checks space/project permissions only                        │
│   • Assumes most documents inherit                               │
│   • ~90% faster, 95% accurate                                   │
│   • Recommended for: Systems with mostly inherited permissions  │
│                                                                  │
│ ○ Disabled (Fastest, least secure)                              │
│   • No permission checks                                         │
│   • All documents treated as:                                    │
│     ⦿ Public  ○ Authenticated Users Only  ○ Private            │
│   • Recommended for: Public documentation only                   │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Advanced Settings (Full Mode)                              │  │
│ ├────────────────────────────────────────────────────────────┤  │
│ │ ☑ Include Group Memberships (slower, more accurate)        │  │
│ │ ☑ Check Inheritance Chain                                  │  │
│ │ ☑ Cache Permissions (5 min TTL)                            │  │
│ │                                                             │  │
│ │ Max Concurrent Permission Calls: [5      ]                  │  │
│ │ Permission Timeout: [5000    ] ms                           │  │
│ │ ☑ Skip permissions on timeout (mark as public)             │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ Impact Estimate:                                                 │
│ • Sync Time: ~2 hours (was 6 hours with full crawling)          │
│ • API Calls: ~10,000 (was 50,000)                               │
│ • Accuracy: 95% (vs 100% with full mode)                        │
│                                                                  │
│ [Test Configuration] [Reset to Defaults] [Save]                 │
└──────────────────────────────────────────────────────────────────┘
```

### 10.6 Performance Comparison

| Mode           | API Calls per 10k Docs | Sync Time  | Accuracy | Use Case                       |
| -------------- | ---------------------- | ---------- | -------- | ------------------------------ |
| **Full**       | 50,000                 | 6 hours    | 100%     | Production with sensitive data |
| **Simplified** | 5,000                  | 2 hours    | 95%      | Most corporate knowledge bases |
| **Disabled**   | 0                      | 30 minutes | N/A      | Public documentation           |

### 10.7 Permission Metrics

```typescript
// Prometheus metrics
counter('searchai_permission_checks', 'Permission checks performed', ['connector_id', 'mode']);
histogram('searchai_permission_check_duration', 'Permission check duration', ['connector_id']);
counter('searchai_permission_cache_hits', 'Permission cache hits', ['connector_id']);
counter('searchai_permission_timeouts', 'Permission check timeouts', ['connector_id']);
gauge('searchai_permission_crawling_overhead', 'Permission crawling overhead %', ['connector_id']);
```

### 10.8 Migration Path

**Existing connectors with full permissions can be migrated**:

1. **Analyze current data**:

   ```sql
   -- Check how many documents have unique permissions
   SELECT
     COUNT(*) as total_docs,
     COUNT(DISTINCT inheritedFrom) as unique_parents,
     COUNT(CASE WHEN inheritedFrom IS NULL THEN 1 END) as unique_perms
   FROM document_permissions
   WHERE connectorId = 'conn_xyz';
   ```

2. **If >90% inherit**: Switch to Simplified mode
3. **If public knowledge base**: Switch to Disabled mode
4. **Test in staging** before applying to production
5. **Monitor accuracy** with sampling

### 10.9 OAuth Scopes & Content Crawl Permissions

#### 10.9.1 Problem Statement

**Critical Distinction**: There are TWO types of permissions in connector architecture:

1. **Content Crawl Permissions** (OAuth Scopes): Permissions granted to the SearchAI app to READ content from the external system
   - Granted ONCE during connector setup
   - Determines WHAT the app can access (e.g., `Sites.Read.All`, `read:jira-work`)
   - Requires admin approval in most enterprise systems

2. **User Document Permissions** (Per-Document ACLs): Permissions that determine which USERS can see which documents at query time
   - Checked for EVERY document during sync (if permission crawling enabled)
   - Determines WHO can see each document
   - Already covered in previous subsections

**The Key Insight**: If permission crawling is **disabled**, we don't need OAuth scopes to READ permissions from the external system. We only need scopes to READ content.

**Impact**:

- ✅ **Reduced OAuth Footprint**: Fewer scopes = easier admin approval
- ✅ **Faster Setup**: Less friction during connector configuration
- ✅ **Security**: Smaller permission surface area = less risk
- ✅ **Compliance**: Some orgs restrict apps with broad permissions

#### 10.9.2 OAuth Scope Matrix by Permission Mode

Each connector requires different OAuth scopes depending on permission crawling mode:

**SharePoint / Microsoft Graph**:

| Feature                    | Permission Mode | Required Scopes                                                                       |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| **Content Only**           | Disabled        | `Sites.Read.All`                                                                      |
| **Content + Permissions**  | Simplified      | `Sites.Read.All`, `Sites.FullControl.All` (for permission API)                        |
| **Content + Permissions**  | Full            | `Sites.Read.All`, `Sites.FullControl.All`, `Directory.Read.All` (for group expansion) |
| **User Activity Tracking** | Any             | `+ Analytics.Read`                                                                    |

**Jira / Atlassian**:

| Feature                    | Permission Mode | Required Scopes                                                              |
| -------------------------- | --------------- | ---------------------------------------------------------------------------- |
| **Content Only**           | Disabled        | `read:jira-work`                                                             |
| **Content + Permissions**  | Simplified      | `read:jira-work`, `read:jira-user` (for permission schemes)                  |
| **Content + Permissions**  | Full            | `read:jira-work`, `read:jira-user`, `read:group:jira` (for group membership) |
| **User Activity Tracking** | Any             | `+ read:audit-log:jira`                                                      |
| **Webhooks**               | Any             | `+ read:webhook:jira`, `write:webhook:jira`                                  |

**Confluence / Atlassian**:

| Feature                    | Permission Mode | Required Scopes                                                                         |
| -------------------------- | --------------- | --------------------------------------------------------------------------------------- |
| **Content Only**           | Disabled        | `read:confluence-content.all`                                                           |
| **Content + Permissions**  | Simplified      | `read:confluence-content.all`, `read:confluence-space.summary`                          |
| **Content + Permissions**  | Full            | `read:confluence-content.all`, `read:confluence-space.summary`, `read:group:confluence` |
| **User Activity Tracking** | Any             | `+ read:analytics:confluence`                                                           |

**ServiceNow**:

| Feature                    | Permission Mode | Required Scopes                                  |
| -------------------------- | --------------- | ------------------------------------------------ |
| **Content Only**           | Disabled        | `read` (table API access)                        |
| **Content + Permissions**  | Any             | `read`, `user_admin` (for ACL and group queries) |
| **User Activity Tracking** | Any             | `+ audit_read`                                   |

**HubSpot**:

| Feature                    | Permission Mode | Required Scopes                                             |
| -------------------------- | --------------- | ----------------------------------------------------------- |
| **Content Only**           | Disabled        | `crm.objects.contacts.read`, `crm.objects.deals.read`, etc. |
| **Content + Permissions**  | Any             | Above + `crm.objects.owners.read`                           |
| **User Activity Tracking** | Any             | `+ crm.objects.deals.read` (engagement timeline)            |

#### 10.9.3 Dynamic Scope Request

**Architecture**: Request minimum scopes initially, request additional scopes only when features are enabled.

```typescript
interface OAuthScopeConfig {
  connectorId: string;
  sourceType: string;

  // Base scopes (always required)
  baseScopes: string[];

  // Conditional scopes (requested based on config)
  conditionalScopes: {
    permissionCrawling?: {
      simplified: string[];
      full: string[];
    };
    userActivityTracking?: string[];
    webhooks?: string[];
    attachments?: string[];
  };

  // Current active scopes
  grantedScopes: string[];
  scopesGrantedAt: Date;

  // Pending scope changes
  pendingScopeRequest?: {
    additionalScopes: string[];
    reason: string; // 'permission_crawling_enabled', 'activity_tracking_enabled', etc.
    requestedAt: Date;
  };
}
```

**Scope Request Flow**:

```typescript
async function requestAdditionalScopes(
  connectorId: string,
  feature: 'permission_crawling' | 'activity_tracking' | 'webhooks',
): Promise<void> {
  const connector = await getConnector(connectorId);
  const currentScopes = connector.oauthConfig.grantedScopes;

  // Determine required scopes for feature
  const additionalScopes = getRequiredScopes(connector.sourceType, feature);

  // Check if already granted
  const missingScopes = additionalScopes.filter((scope) => !currentScopes.includes(scope));

  if (missingScopes.length === 0) {
    logger.info(`All required scopes already granted`, { connectorId, feature });
    return;
  }

  // Request additional scopes
  logger.info(`Requesting additional OAuth scopes`, {
    connectorId,
    feature,
    missingScopes,
  });

  // Store pending request
  await updateConnector(connectorId, {
    'oauthConfig.pendingScopeRequest': {
      additionalScopes: missingScopes,
      reason: `${feature}_enabled`,
      requestedAt: new Date(),
    },
  });

  // Trigger OAuth re-authorization flow
  await triggerOAuthReauthorization(connectorId, [...currentScopes, ...missingScopes]);
}
```

#### 10.9.4 Admin Approval Workflow

**Challenge**: Many enterprise systems require admin approval for app permissions.

**Solution**: Progressive authorization with clear justification.

```
┌──────────────────────────────────────────────────────────────────┐
│ Additional Permissions Required                                  │
├──────────────────────────────────────────────────────────────────┤
│ Feature: Permission Crawling (Simplified Mode)                   │
│                                                                  │
│ SearchAI needs additional permissions to check document          │
│ permissions from SharePoint.                                     │
│                                                                  │
│ Requested Scopes:                                                │
│ • Sites.FullControl.All                                          │
│   - Reason: Read permission lists for documents                  │
│   - Risk: Read-only access to permissions (no write)             │
│                                                                  │
│ Alternative: Disable permission crawling and mark all documents  │
│ as "Authenticated Users Only"                                    │
│                                                                  │
│ ⚠️  Admin approval required from Microsoft 365 admin             │
│                                                                  │
│ [Request Admin Approval] [Configure Without Permissions]         │
└──────────────────────────────────────────────────────────────────┘
```

#### 10.9.5 Scope Validation

**Before sync starts**, validate that granted scopes match configuration:

```typescript
async function validateScopes(connector: Connector): Promise<ValidationResult> {
  const required = getRequiredScopes(connector.sourceType, {
    permissionCrawling: connector.permissionConfig.enabled && connector.permissionConfig.mode,
    activityTracking: connector.activityTrackingEnabled,
    webhooks: connector.webhookEnabled
  });

  const granted = connector.oauthConfig.grantedScopes;
  const missing = required.filter(scope => !granted.includes(scope));

  if (missing.length > 0) {
    return {
      valid: false,
      missingScopes: missing,
      recommendation: getMissingScop eRecommendation(missing)
    };
  }

  return { valid: true };
}

// Before sync
const validation = await validateScopes(connector);
if (!validation.valid) {
  throw new Error(
    `Cannot sync: Missing OAuth scopes: ${validation.missingScopes.join(', ')}. ` +
    `Recommendation: ${validation.recommendation}`
  );
}
```

#### 10.9.6 Scope Downgrade on Feature Disable

**When permission crawling is disabled**, offer to downgrade scopes:

```typescript
async function onPermissionCrawlingDisabled(connectorId: string): Promise<void> {
  const connector = await getConnector(connectorId);

  // Check if we have permission-related scopes
  const permissionScopes = getPermissionScopes(connector.sourceType);
  const hasPermissionScopes = permissionScopes.some((scope) =>
    connector.oauthConfig.grantedScopes.includes(scope),
  );

  if (hasPermissionScopes) {
    // Notify admin
    await notifyAdmin({
      type: 'scope_downgrade_available',
      connectorId,
      message: `Permission crawling disabled. You can revoke these scopes: ${permissionScopes.join(', ')}`,
      action: 'revoke_scopes',
      scopesToRevoke: permissionScopes,
    });
  }
}
```

#### 10.9.7 Connector-Specific OAuth Implementation Examples

**SharePoint OAuth Flow**:

```typescript
// Step 1: Determine required scopes
function getSharePointScopes(config: ConnectorConfig): string[] {
  const scopes = ['Sites.Read.All']; // Base

  if (config.permissionConfig.enabled) {
    if (config.permissionConfig.mode === 'full') {
      scopes.push('Sites.FullControl.All', 'Directory.Read.All');
    } else if (config.permissionConfig.mode === 'simplified') {
      scopes.push('Sites.FullControl.All');
    }
  }

  if (config.activityTrackingEnabled) {
    scopes.push('Analytics.Read');
  }

  return scopes;
}

// Step 2: Build OAuth authorization URL
function buildSharePointAuthUrl(connectorId: string, scopes: string[]): string {
  return (
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
    `client_id=${clientId}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(callbackUrl)}&` +
    `scope=${encodeURIComponent(scopes.join(' '))}&` +
    `state=${connectorId}`
  );
}
```

**Jira OAuth Flow (OAuth 2.0 3LO)**:

```typescript
function getJiraScopes(config: ConnectorConfig): string[] {
  const scopes = ['read:jira-work', 'read:jira-user']; // Base

  if (config.permissionConfig.enabled && config.permissionConfig.mode === 'full') {
    scopes.push('read:group:jira');
  }

  if (config.activityTrackingEnabled) {
    scopes.push('read:audit-log:jira');
  }

  if (config.webhookEnabled) {
    scopes.push('read:webhook:jira', 'write:webhook:jira');
  }

  return scopes;
}

function buildJiraAuthUrl(connectorId: string, scopes: string[]): string {
  return (
    `https://auth.atlassian.com/authorize?` +
    `audience=api.atlassian.com&` +
    `client_id=${clientId}&` +
    `scope=${encodeURIComponent(scopes.join(' '))}&` +
    `redirect_uri=${encodeURIComponent(callbackUrl)}&` +
    `state=${connectorId}&` +
    `response_type=code&` +
    `prompt=consent`
  ); // Always show consent screen to display scopes
}
```

#### 10.9.8 Scope Documentation

For each connector, document scope justification for security review:

**SharePoint Scope Justification**:

| Scope                   | Justification                          | Alternatives                               |
| ----------------------- | -------------------------------------- | ------------------------------------------ |
| `Sites.Read.All`        | Read document content, metadata, lists | None - minimum required                    |
| `Sites.FullControl.All` | Read permission lists for documents    | Use Disabled mode (no permission checking) |
| `Directory.Read.All`    | Expand Azure AD groups to users        | Use Simplified mode (don't expand groups)  |
| `Analytics.Read`        | Read document view/edit analytics      | Disable activity tracking                  |

**Jira Scope Justification**:

| Scope                 | Justification                             | Alternatives                  |
| --------------------- | ----------------------------------------- | ----------------------------- |
| `read:jira-work`      | Read issues, comments, attachments        | None - minimum required       |
| `read:jira-user`      | Read user profiles and permission schemes | Use Disabled mode             |
| `read:group:jira`     | Expand Jira groups to users               | Use Simplified mode           |
| `read:audit-log:jira` | Read issue view/edit history              | Disable activity tracking     |
| `write:webhook:jira`  | Register webhooks for real-time updates   | Disable webhooks, use polling |

#### 10.9.9 Security Best Practices

1. **Principle of Least Privilege**: Only request scopes required for enabled features
2. **Scope Rotation**: When features are disabled, revoke unnecessary scopes
3. **Admin Transparency**: Show admin exactly which scopes are needed and why
4. **Audit Logging**: Log all scope changes with justification
5. **Token Security**: Store OAuth tokens encrypted at rest (AES-256-GCM)
6. **Token Refresh**: Implement automatic token refresh before expiration
7. **Token Revocation**: Support manual token revocation by admin

---

## 12. CLI-First Configuration

### 11.1 Design Philosophy

**Core Principle**: The entire connector configuration and management workflow must work via CLI without requiring a UI. The UI is built later as a convenience layer on top of the CLI.

**Why CLI-First**:

- ✅ **Automation**: Enable CI/CD pipelines and infrastructure-as-code
- ✅ **Scriptability**: Bulk operations and batch configuration
- ✅ **Remote Management**: Configure connectors on headless servers
- ✅ **Version Control**: Configuration files can be committed to git
- ✅ **Testing**: Easier to write automated tests
- ✅ **Accessibility**: Works over SSH, doesn't require graphical environment

### 11.2 CLI Tool Architecture

```
searchai-cli
├── connector
│   ├── create        # Create new connector
│   ├── list          # List all connectors
│   ├── get           # Get connector details
│   ├── update        # Update connector configuration
│   ├── delete        # Delete connector
│   ├── auth          # Handle OAuth authentication
│   ├── test          # Test connector connection
│   └── sync          # Trigger manual sync
├── filter
│   ├── set           # Configure sync filters
│   ├── get           # Get current filters
│   ├── test          # Test filters (preview results)
│   └── clear         # Remove all filters
├── permission
│   ├── mode          # Set permission crawling mode
│   ├── get           # Get current permission config
│   └── scopes        # Show required OAuth scopes
├── sync
│   ├── start         # Start sync job
│   ├── stop          # Stop running sync
│   ├── pause         # Pause sync
│   ├── resume        # Resume paused sync
│   ├── status        # Check sync status
│   └── logs          # View sync logs
└── config
    ├── export        # Export connector config to file
    ├── import        # Import connector config from file
    └── validate      # Validate configuration
```

### 11.3 OAuth Flow in CLI

**Challenge**: Traditional OAuth requires browser redirects, but CLI runs in terminal.

**Solution**: Use **OAuth Device Code Flow** (RFC 8628) for CLI authentication.

#### 11.3.1 Device Code Flow

```bash
$ searchai-cli connector auth jira --connector-id conn_abc123

⏳ Authenticating with Jira...

Please visit the following URL in your browser:
https://auth.atlassian.com/activate?user_code=WDJB-MJHT

And enter this code: WDJB-MJHT

Waiting for authorization... (expires in 15 minutes)

✓ Authorization successful!
✓ Access token received and stored securely
✓ Scopes granted: read:jira-work, read:jira-user

Next steps:
• Test connection: searchai-cli connector test conn_abc123
• Start sync: searchai-cli sync start conn_abc123
```

**Flow Diagram**:

```
┌──────────┐                  ┌──────────────┐              ┌──────────┐
│   CLI    │                  │ OAuth Server │              │ Browser  │
└────┬─────┘                  └──────┬───────┘              └────┬─────┘
     │                               │                           │
     │ 1. Request device code        │                           │
     │─────────────────────────────>│                           │
     │                               │                           │
     │ 2. device_code, user_code     │                           │
     │<─────────────────────────────│                           │
     │                               │                           │
     │ 3. Display URL and code       │                           │
     │────────────────────────────────────────────────────────────>│
     │                               │                           │
     │                               │ 4. Enter user_code        │
     │                               │<──────────────────────────│
     │                               │                           │
     │                               │ 5. User authorizes        │
     │                               │<──────────────────────────│
     │                               │                           │
     │ 6. Poll for token (every 5s)  │                           │
     │─────────────────────────────>│                           │
     │                               │                           │
     │ 7. Access token + refresh     │                           │
     │<─────────────────────────────│                           │
     │                               │                           │
     │ 8. Store tokens securely      │                           │
     │                               │                           │
```

#### 11.3.2 Implementation

```typescript
async function authenticateViaDeviceCodeFlow(
  sourceType: string,
  requiredScopes: string[],
): Promise<OAuthTokens> {
  // 1. Request device code
  const deviceCodeResponse = await fetch(getDeviceCodeUrl(sourceType), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: getClientId(sourceType),
      scope: requiredScopes.join(' '),
    }),
  });

  const { device_code, user_code, verification_uri, expires_in, interval } =
    await deviceCodeResponse.json();

  // 2. Display instructions to user
  console.log('\n⏳ Authenticating with', sourceType);
  console.log('\nPlease visit the following URL in your browser:');
  console.log(chalk.cyan.bold(verification_uri));
  console.log('\nAnd enter this code:', chalk.yellow.bold(user_code));
  console.log('\nWaiting for authorization... (expires in', expires_in / 60, 'minutes)\n');

  // 3. Poll for token
  const startTime = Date.now();
  while (Date.now() - startTime < expires_in * 1000) {
    await sleep(interval * 1000);

    try {
      const tokenResponse = await fetch(getTokenUrl(sourceType), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: getClientId(sourceType),
          device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      if (tokenResponse.status === 200) {
        const tokens = await tokenResponse.json();

        console.log(chalk.green('✓ Authorization successful!'));
        console.log(chalk.green('✓ Access token received and stored securely'));
        console.log(chalk.green('✓ Scopes granted:'), tokens.scope);

        return tokens;
      } else if (tokenResponse.status === 400) {
        const error = await tokenResponse.json();
        if (error.error === 'authorization_pending') {
          // Still waiting, continue polling
          continue;
        } else if (error.error === 'expired_token') {
          throw new Error('Authorization expired. Please try again.');
        } else {
          throw new Error(`Authorization failed: ${error.error_description}`);
        }
      }
    } catch (error) {
      // Continue polling on network errors
      continue;
    }
  }

  throw new Error('Authorization timeout. Please try again.');
}
```

### 11.4 Complete CLI Workflow Examples

#### 11.4.1 Create Jira Connector

```bash
# Step 1: Create connector configuration file
$ cat > jira-connector.json <<EOF
{
  "name": "Jira Production",
  "sourceType": "jira",
  "connectionConfig": {
    "baseUrl": "https://company.atlassian.net",
    "cloudId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  },
  "syncSchedule": "0 */6 * * *",
  "filterConfig": {
    "enabled": true,
    "commonFilters": {
      "modifiedAfter": "2024-01-01T00:00:00Z"
    },
    "sourceSpecificFilters": {
      "includeProjects": ["ENG", "DESIGN"],
      "includeStatuses": ["Open", "In Progress"],
      "includeLabels": ["customer-facing"]
    }
  },
  "permissionConfig": {
    "enabled": true,
    "mode": "simplified"
  }
}
EOF

# Step 2: Create connector (validates config, doesn't auth yet)
$ searchai-cli connector create --config jira-connector.json

✓ Connector configuration validated
✓ Connector created: conn_jira_prod_abc123

⚠️  OAuth authentication required
Required scopes for your configuration:
  • read:jira-work (Content access)
  • read:jira-user (Permission checking - simplified mode)

# Step 3: Authenticate
$ searchai-cli connector auth jira --connector-id conn_jira_prod_abc123

⏳ Authenticating with Jira...
Please visit: https://auth.atlassian.com/activate?user_code=WDJB-MJHT
Enter code: WDJB-MJHT

✓ Authorization successful!
✓ Scopes granted: read:jira-work, read:jira-user

# Step 4: Test connection
$ searchai-cli connector test conn_jira_prod_abc123

⏳ Testing connection to Jira...
✓ Connection successful
✓ Base URL accessible: https://company.atlassian.net
✓ OAuth scopes validated
✓ Filter test: Found ~5,234 issues matching filters
✓ Permission test: Successfully fetched permissions for sample issues

# Step 5: Start sync
$ searchai-cli sync start conn_jira_prod_abc123

✓ Sync job started: job_xyz789
⏳ Syncing 5,234 issues...

Progress: [████████░░░░░░░] 65% (3,402 / 5,234)
ETA: 15 minutes
Throughput: 12.5 issues/min

Follow logs: searchai-cli sync logs job_xyz789
```

#### 11.4.2 Update Permission Mode

```bash
# Check current configuration
$ searchai-cli permission get conn_jira_prod_abc123

Current permission configuration:
  Mode: simplified
  Scopes granted: read:jira-work, read:jira-user

# Change to full mode
$ searchai-cli permission mode full --connector-id conn_jira_prod_abc123

⚠️  Changing permission mode to 'full' requires additional OAuth scopes:
  • read:group:jira (Group membership expansion)

Current scopes: read:jira-work, read:jira-user
Required scopes: read:jira-work, read:jira-user, read:group:jira

Would you like to re-authorize now? (y/n): y

⏳ Re-authenticating with Jira...
Please visit: https://auth.atlassian.com/activate?user_code=XKYP-QMRT
Enter code: XKYP-QMRT

✓ Authorization successful!
✓ Permission mode updated to 'full'
✓ Next sync will use full permission crawling
```

#### 11.4.3 Disable Permission Crawling

```bash
$ searchai-cli permission mode disabled --connector-id conn_jira_prod_abc123

⚠️  Disabling permission crawling will:
  • Mark all documents as 'authenticated' (any logged-in user can see them)
  • Reduce sync time by ~60%
  • Revoke 'read:jira-user' OAuth scope (optional)

Continue? (y/n): y

✓ Permission crawling disabled
✓ Default visibility set to 'authenticated'

ℹ️  You can revoke the 'read:jira-user' OAuth scope:
  searchai-cli connector auth revoke conn_jira_prod_abc123 --scope read:jira-user
```

#### 11.4.4 Configure Filters

```bash
# Test filters before applying
$ searchai-cli filter test conn_jira_prod_abc123 \
  --include-projects ENG,DESIGN \
  --include-statuses "Open,In Progress" \
  --modified-after 2024-01-01

⏳ Testing filters...
✓ Filter query generated:
  project IN (ENG, DESIGN) AND status IN ("Open", "In Progress") AND updated >= "2024-01-01"

✓ Estimated results: 5,234 issues (68% savings vs 15,234 total)

Sample results:
  • ENG-1234: Fix authentication bug (Open)
  • DESIGN-567: New landing page mockup (In Progress)
  • ENG-2345: API rate limiting (Open)
  ... (showing 3 of 5,234)

# Apply filters
$ searchai-cli filter set conn_jira_prod_abc123 \
  --include-projects ENG,DESIGN \
  --include-statuses "Open,In Progress" \
  --modified-after 2024-01-01

✓ Filters updated
✓ Next sync will apply these filters
```

#### 11.4.5 Export/Import Configuration

```bash
# Export connector configuration
$ searchai-cli config export conn_jira_prod_abc123 > jira-prod.json

✓ Configuration exported to jira-prod.json

# Import to new connector (e.g., staging environment)
$ searchai-cli config import jira-staging.json

⏳ Validating configuration...
✓ Configuration valid
✓ Connector created: conn_jira_staging_def456

⚠️  OAuth authentication required (tokens not exported for security)
Run: searchai-cli connector auth jira --connector-id conn_jira_staging_def456
```

### 11.5 Configuration File Format

```json
{
  "name": "Jira Production",
  "sourceType": "jira",
  "connectionConfig": {
    "baseUrl": "https://company.atlassian.net",
    "cloudId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  },
  "syncSchedule": "0 */6 * * *",
  "syncEnabled": true,
  "filterConfig": {
    "enabled": true,
    "commonFilters": {
      "modifiedAfter": "2024-01-01T00:00:00Z",
      "maxSizeBytes": 104857600,
      "excludeFileExtensions": [".zip", ".exe"]
    },
    "sourceSpecificFilters": {
      "includeProjects": ["ENG", "DESIGN"],
      "includeStatuses": ["Open", "In Progress", "Code Review"],
      "includeLabels": ["customer-facing"],
      "customJQL": null
    }
  },
  "permissionConfig": {
    "enabled": true,
    "mode": "simplified",
    "fullModeConfig": {
      "includeGroups": true,
      "includeInheritance": true,
      "cachePermissions": true,
      "cacheTTL": 300
    },
    "simplifiedModeConfig": {
      "assumeInheritance": true,
      "onlyCheckParentPermissions": true,
      "sampleRate": 0.1
    },
    "disabledModeConfig": {
      "defaultVisibility": "authenticated"
    },
    "performanceConfig": {
      "maxConcurrentPermissionCalls": 5,
      "permissionCallTimeoutMs": 5000,
      "skipPermissionsOnTimeout": true
    }
  },
  "webhookEnabled": false
}
```

### 11.6 CLI Implementation Challenges & Solutions

| Challenge                   | Solution                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **OAuth in Terminal**       | Use OAuth Device Code Flow (RFC 8628) with browser activation                                                   |
| **Token Storage**           | Encrypt tokens at rest using system keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) |
| **Token Refresh**           | Background daemon refreshes tokens before expiration                                                            |
| **Concurrent CLI Calls**    | File-based locking for concurrent protection                                                                    |
| **Progress Display**        | Use TTY detection, fallback to periodic log lines if piped                                                      |
| **Config Validation**       | JSON Schema validation before API call                                                                          |
| **Error Handling**          | Clear error messages with actionable next steps                                                                 |
| **Offline Mode**            | Cache connector list locally, sync when online                                                                  |
| **Large Outputs**           | Pagination with `--limit` and `--offset` flags                                                                  |
| **Interactive vs Scripted** | Detect TTY, skip confirmations if `--yes` flag                                                                  |

### 11.7 Token Security

```typescript
// Store tokens in system keychain
import keytar from 'keytar';

async function storeTokens(connectorId: string, tokens: OAuthTokens): Promise<void> {
  // Encrypt tokens before storing
  const encrypted = await encrypt(JSON.stringify(tokens), getEncryptionKey());

  // Store in system keychain
  await keytar.setPassword(
    'searchai-cli', // service
    connectorId, // account
    encrypted, // password
  );

  logger.info(`Tokens stored securely for connector ${connectorId}`);
}

async function getTokens(connectorId: string): Promise<OAuthTokens | null> {
  const encrypted = await keytar.getPassword('searchai-cli', connectorId);

  if (!encrypted) {
    return null;
  }

  const decrypted = await decrypt(encrypted, getEncryptionKey());
  return JSON.parse(decrypted);
}
```

### 11.8 UI as CLI Wrapper (Future)

When UI is built, it should call the same CLI commands under the hood:

```typescript
// UI button click
async function onConnectorCreateClick(config: ConnectorConfig) {
  // UI calls CLI command
  const result = await exec(`searchai-cli connector create --config -`, {
    input: JSON.stringify(config),
  });

  if (result.exitCode === 0) {
    showSuccess('Connector created successfully');
    const connectorId = parseConnectorId(result.stdout);
    navigateTo(`/connectors/${connectorId}`);
  } else {
    showError(result.stderr);
  }
}
```

This ensures:

- ✅ Feature parity between CLI and UI
- ✅ Single source of truth for business logic
- ✅ UI can be developed incrementally
- ✅ Users can script what they do in UI

### 11.9 Challenges and Solutions

Building a CLI-first connector configuration system presents several unique challenges. This section documents each challenge and our solution approach.

#### 11.9.1 OAuth in Terminal Environments

**Challenge**: Traditional OAuth flows require browser redirects (authorization code flow), which don't work in terminal environments. Users can't complete authentication without a web server to receive the callback.

**Solution**: OAuth Device Code Flow (RFC 8628)

- CLI displays a URL and short code
- User opens URL in any browser (even on different device)
- User enters code to authorize
- CLI polls OAuth server for token
- Works on SSH sessions, CI/CD runners, Docker containers

**Trade-offs**:

- ✅ Works in any environment (even headless)
- ✅ Supports cross-device auth (phone to authorize server CLI)
- ⚠️ Slightly more user steps (copy/paste code)
- ⚠️ Not supported by all OAuth providers (workaround: run local server temporarily)

**Alternative for providers without Device Code Flow**:

```bash
# Fallback: Start temporary local server for callback
$ searchai-cli connector auth salesforce --connector-id conn_123
⚠️  Salesforce doesn't support Device Code Flow
⏳ Starting temporary local server on http://localhost:8765/callback

Please visit: https://login.salesforce.com/oauth2/authorize?...
Browser will open automatically in 3 seconds...

✓ Authorization received!
✓ Temporary server stopped
```

#### 11.9.2 Token Security Across Systems

**Challenge**: OAuth tokens must be stored securely on developer machines, but different operating systems have different security mechanisms. Plain text storage is unacceptable.

**Solution**: System Keychain Integration

- **macOS**: Keychain Access API
- **Windows**: Windows Credential Manager
- **Linux**: Secret Service API (GNOME Keyring, KWallet)

**Implementation**:

```typescript
import keytar from 'keytar'; // Cross-platform keychain library

// Store with automatic OS-level encryption
await keytar.setPassword('searchai-cli', connectorId, encryptedTokens);

// Retrieve
const encryptedTokens = await keytar.getPassword('searchai-cli', connectorId);
```

**Trade-offs**:

- ✅ OS-native encryption (AES-256 on most systems)
- ✅ Protected by user's login credentials
- ✅ Survives CLI updates
- ⚠️ Requires keytar native module (adds 2MB to binary)
- ⚠️ Headless Linux may need libsecret-1-dev package

**Fallback for minimal environments**:

```bash
# If keychain unavailable, encrypt with machine-specific key
$ searchai-cli connector auth --use-file-storage
⚠️  Keychain not available, using encrypted file storage
ℹ️  Tokens will be stored in ~/.searchai/credentials.enc
```

#### 11.9.3 Progress Display in Non-TTY Environments

**Challenge**: Rich progress indicators (spinners, progress bars, live updates) don't work in non-interactive environments like CI/CD pipelines or when output is redirected to files.

**Solution**: Auto-detect TTY and adapt output

```typescript
import { isTTY } from 'tty';

function showProgress(job: SyncJob) {
  if (process.stdout.isTTY) {
    // Interactive terminal: Use rich progress bar
    renderProgressBar(job);
  } else {
    // Non-interactive: Use line-based logging
    console.log(
      `[${job.timestamp}] Progress: ${job.processedObjects}/${job.totalObjects} (${job.percentComplete}%)`,
    );
  }
}
```

**Trade-offs**:

- ✅ Automatic detection, no config needed
- ✅ Works in all environments
- ✅ Logs are parseable in non-TTY mode
- ⚠️ Different output format may confuse users switching contexts

**Force modes**:

```bash
# Force interactive mode (for screen recordings)
$ searchai-cli sync start conn_123 --interactive

# Force non-interactive mode (for scripts)
$ searchai-cli sync start conn_123 --no-interactive | tee sync.log
```

#### 11.9.4 Handling Long-Running Operations

**Challenge**: Connector syncs can run for hours (e.g., 100K documents). Network failures, terminal disconnections, or SSH timeouts can interrupt operations and lose progress.

**Solution**: Server-side sync execution with detached mode

```bash
# Start sync in detached mode (runs on server)
$ searchai-cli sync start conn_123 --detach
✓ Sync job started: job_xyz789
ℹ️  Job is running on server, safe to close terminal

# Check status later
$ searchai-cli sync status job_xyz789
Status: running
Progress: 45,231 / 100,000 (45%)
ETA: 2 hours 15 minutes

# Stream logs
$ searchai-cli sync logs job_xyz789 --follow
[12:34:56] Processing document: DOC-12345
[12:34:57] Processing document: DOC-12346
...
```

**Trade-offs**:

- ✅ Survives terminal disconnection
- ✅ Can monitor from multiple terminals
- ✅ Server maintains progress automatically
- ⚠️ Requires server-side job queue (BullMQ already in architecture)
- ⚠️ User doesn't see immediate errors (must check logs)

**Foreground mode for development**:

```bash
# Block until complete (default for short operations)
$ searchai-cli sync start conn_123
⏳ Syncing... 1,234 / 5,000 (24%) - ETA 5 minutes
^C
⚠️  Interrupted! Sync will continue on server.
ℹ️  Check status with: searchai-cli sync status job_xyz789
```

#### 11.9.5 Concurrent CLI Invocations

**Challenge**: Users may accidentally run multiple CLI commands simultaneously (e.g., two sync jobs, or sync + config update). This can cause race conditions on connector state.

**Solution**: Server-side locking with clear error messages

```typescript
// Server enforces connector-level locks
async function acquireLock(connectorId: string, operation: string): Promise<Lock> {
  const lock = await redis.get(`lock:connector:${connectorId}`);

  if (lock) {
    const lockInfo = JSON.parse(lock);
    throw new ConflictError(
      `Connector ${connectorId} is locked by ${lockInfo.operation} (started ${lockInfo.startedAt}).\n` +
        `Wait for it to complete or stop it with: searchai-cli sync stop ${lockInfo.jobId}`,
    );
  }

  // Acquire lock
  await redis.setex(
    `lock:connector:${connectorId}`,
    3600, // 1 hour expiry
    JSON.stringify({ operation, startedAt: new Date(), jobId: uuidv7() }),
  );
}
```

**Trade-offs**:

- ✅ Prevents race conditions
- ✅ Clear error messages tell user what's running
- ⚠️ Lock expiry (1 hour) may cause issues for very long syncs
- ⚠️ Must handle lock cleanup on crashes

**Lock override for emergencies**:

```bash
# Force operation despite lock
$ searchai-cli connector update conn_123 --force
⚠️  Connector is locked by sync operation (started 30 minutes ago)
❓ Force unlock and proceed? (y/N): y
✓ Lock released, proceeding with update
```

#### 11.9.6 Configuration Validation

**Challenge**: Complex connector configurations have many interdependencies (e.g., permission mode requires specific OAuth scopes, filters must match source schema). Users can create invalid configs that fail at runtime.

**Solution**: Multi-stage validation with dry-run

```bash
# 1. Schema validation (immediate)
$ searchai-cli connector create --config config.json
❌ Validation failed:
  • permissionConfig.mode = "full" requires OAuth scope "read:group:jira"
  • filterConfig.sourceSpecificFilters.projects: ["INVALID"] contains non-existent project keys

Fix these errors or add missing scopes with: searchai-cli connector auth conn_123 --add-scopes

# 2. Test connection (before first sync)
$ searchai-cli connector test conn_123
⏳ Testing connection...
✓ Authentication successful
✓ OAuth scopes valid
⚠️ Warning: Filter projects=["PROJ1"] returned 0 issues (filter may be too restrictive)
⚠️ Warning: Permission crawling mode "full" detected. This will slow down sync by ~3x.

Proceed with sync? (y/N): y

# 3. Dry run (preview results)
$ searchai-cli sync start conn_123 --dry-run
⏳ Dry run: Scanning first 100 documents...

Results:
  • 87 issues would be indexed
  • 13 issues excluded by filters
  • Estimated sync time: 2 hours 30 minutes
  • Estimated API calls: 8,700 (within rate limit)

Start actual sync? (y/N): y
```

**Trade-offs**:

- ✅ Catch errors before expensive operations
- ✅ Educate users on config impact
- ✅ Prevents wasted time on failed syncs
- ⚠️ Requires calling external APIs for validation (costs quota)
- ⚠️ Dry run isn't perfect (live data may differ)

#### 11.9.7 Cross-Platform Compatibility

**Challenge**: CLI must work on Windows, macOS, and Linux with different shells (bash, zsh, PowerShell), path conventions, and terminal capabilities.

**Solution**: Abstract platform differences with compatibility layer

```typescript
// Path handling
import path from 'path';
const configPath = path.join(getHomeDir(), '.searchai', 'config.json'); // Works on all platforms

// Shell execution
import { spawn } from 'child_process';
const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';

// Color support detection
import chalk from 'chalk';
chalk.level = detectColorSupport(); // Auto-detect 256-color, truecolor, or no color

// Line endings
const EOL = process.platform === 'win32' ? '\r\n' : '\n';
```

**Trade-offs**:

- ✅ Single codebase for all platforms
- ✅ Libraries handle most differences
- ⚠️ Must test on all platforms (CI/CD matrix required)
- ⚠️ Windows PowerShell has different quoting rules

**Platform-specific documentation**:

```bash
# Installation varies by platform
# macOS / Linux
$ npm install -g @searchai/cli

# Windows (PowerShell as admin)
PS> npm install -g @searchai/cli
PS> Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

#### 11.9.8 Admin Approval Workflows

**Challenge**: Enterprise OAuth apps often require admin approval before users can grant scopes. This is a multi-person workflow that can block CLI setup.

**Solution**: Pre-approval guidance and scope request tracking

```bash
# User attempts auth without admin pre-approval
$ searchai-cli connector auth sharepoint --connector-id conn_123
⏳ Requesting OAuth scopes: Sites.Read.All, Sites.FullControl.All

❌ Error: Admin approval required
   The following scopes require tenant admin approval:
   • Sites.FullControl.All (Read permissions for documents)

   Next steps:
   1. Share this approval request with your admin:
      https://login.microsoft.com/admin/consent?client_id=...

   2. Admin approves scopes in Azure AD Admin Center

   3. Retry authentication:
      searchai-cli connector auth sharepoint --connector-id conn_123

   Or disable permission crawling to remove scope requirement:
      searchai-cli permission mode conn_123 --mode disabled
```

**Track approval status**:

```typescript
interface ScopeApprovalRequest {
  requestId: string;
  connectorId: string;
  requestedScopes: string[];
  requestedBy: string;
  requestedAt: Date;
  approvalUrl: string;
  status: 'pending' | 'approved' | 'denied';
  approvedBy?: string;
  approvedAt?: Date;
}

// Admin can review pending requests
$ searchai-cli admin scope-requests list
ID       Connector   User        Scopes                    Status    Requested
req_123  conn_abc    john@co.uk  Sites.FullControl.All    pending   2026-02-23
req_124  conn_xyz    jane@co.uk  read:group:jira          approved  2026-02-22
```

**Trade-offs**:

- ✅ Clear guidance for multi-person workflow
- ✅ Users aren't blocked (can disable features)
- ✅ Trackable for compliance
- ⚠️ Requires admin involvement (delays setup)
- ⚠️ Must maintain approval URL templates per provider

#### 11.9.9 Network Failures During Sync

**Challenge**: Long-running syncs make thousands of API calls over hours. Network failures, rate limits, or API downtime will interrupt operations.

**Solution**: Automatic retry with exponential backoff + checkpointing

```typescript
async function syncWithRetry(job: SyncJob) {
  const checkpoint = await loadCheckpoint(job.jobId);
  let cursor = checkpoint?.cursor || null;
  let retryCount = 0;
  const maxRetries = 3;

  while (true) {
    try {
      const page = await connector.listDocuments({ cursor, limit: 100 });

      // Process documents
      for (const doc of page.documents) {
        await indexDocument(doc);
        await incrementProgress(job.jobId);
      }

      // Save checkpoint every 100 documents
      cursor = page.nextCursor;
      await saveCheckpoint(job.jobId, { cursor, processedObjects: job.progress.processedObjects });

      if (!page.hasMore) break;

      retryCount = 0; // Reset on success
    } catch (error) {
      if (isNetworkError(error) || isRateLimitError(error)) {
        retryCount++;

        if (retryCount > maxRetries) {
          await pauseJob(job.jobId, `Max retries exceeded: ${error.message}`);
          throw error;
        }

        // Exponential backoff: 5s, 10s, 20s
        const backoffMs = Math.pow(2, retryCount) * 5000;
        console.log(
          `⚠️  ${error.message}. Retrying in ${backoffMs / 1000}s... (${retryCount}/${maxRetries})`,
        );
        await sleep(backoffMs);

        // Resume from checkpoint
        continue;
      }

      // Non-retryable error
      throw error;
    }
  }
}
```

**Trade-offs**:

- ✅ Automatic recovery from transient failures
- ✅ Resume from exact position (no duplicate work)
- ✅ Exponential backoff prevents API hammering
- ⚠️ Requires checkpoint storage (MongoDB/Redis)
- ⚠️ Very long outages may exceed max retries (manual resume needed)

**Manual intervention**:

```bash
# Sync paused due to network failure
$ searchai-cli sync status job_xyz789
Status: paused
Reason: Max retries exceeded: ECONNREFUSED

Progress: 45,231 / 100,000 (45%)
Last checkpoint: 2026-02-23 14:35:12

# Resume when network restored
$ searchai-cli sync resume job_xyz789
✓ Resuming from checkpoint (45,231 documents processed)
⏳ Syncing... 45,232 / 100,000 (45%)
```

#### 11.9.10 Debugging and Troubleshooting

**Challenge**: When things go wrong, users need detailed logs to diagnose issues. But verbose logging makes normal operation too noisy.

**Solution**: Graduated logging levels with structured output

```bash
# Normal operation (minimal output)
$ searchai-cli sync start conn_123
⏳ Syncing... 1,234 / 5,000 (24%) - ETA 5 minutes

# Verbose mode (show API calls)
$ searchai-cli sync start conn_123 --verbose
[12:34:56] INFO: Starting sync job job_xyz789
[12:34:56] DEBUG: Fetching documents with cursor=null limit=100
[12:34:57] DEBUG: API call: GET /rest/api/3/search?jql=...
[12:34:58] DEBUG: Received 100 documents
[12:34:58] INFO: Processing document: ISSUE-12345

# Debug mode (show full request/response)
$ searchai-cli sync start conn_123 --debug
[12:34:56] DEBUG: Config: {"permissionMode":"full","filters":{...}}
[12:34:57] DEBUG: Request: GET https://api.atlassian.com/ex/jira/...
  Headers: {Authorization: "Bearer eyJ...", ...}
  Body: null
[12:34:58] DEBUG: Response: 200 OK
  Headers: {Content-Type: "application/json", ...}
  Body: {"issues":[{...}]}

# Export logs to file for support
$ searchai-cli sync start conn_123 --debug --log-file sync.log 2>&1 | tee sync.log
```

**Structured logging for parsing**:

```bash
# JSON output for programmatic consumption
$ searchai-cli sync status conn_123 --format json
{
  "jobId": "job_xyz789",
  "status": "running",
  "progress": {
    "processedObjects": 1234,
    "totalObjects": 5000,
    "percentComplete": 24.68
  },
  "eta": "2026-02-23T16:45:00Z"
}

# Use with jq for filtering
$ searchai-cli connector list --format json | jq '.[] | select(.status == "active")'
```

**Trade-offs**:

- ✅ Clean output by default
- ✅ Deep inspection when needed
- ✅ Machine-readable for automation
- ⚠️ Debug mode can generate huge log files (rate limit to 100MB)
- ⚠️ Must sanitize sensitive data (tokens, passwords) in logs

#### 11.9.11 Summary: Challenge Mitigation

| Challenge              | Impact | Solution                    | Residual Risk                                 |
| ---------------------- | ------ | --------------------------- | --------------------------------------------- |
| OAuth in terminal      | High   | Device Code Flow            | Low (workaround for non-supporting providers) |
| Token security         | High   | System keychain             | Low (fallback for minimal envs)               |
| Non-TTY environments   | Medium | Auto-detect TTY             | Low (force modes available)                   |
| Long-running ops       | High   | Detached mode + server jobs | Low (requires job queue)                      |
| Concurrent invocations | Medium | Server-side locking         | Low (lock expiry edge case)                   |
| Config validation      | High   | Multi-stage validation      | Medium (external APIs may be unreachable)     |
| Cross-platform         | Medium | Compatibility layer         | Low (requires multi-platform testing)         |
| Admin approvals        | Medium | Guidance + tracking         | Medium (still requires human coordination)    |
| Network failures       | High   | Auto-retry + checkpointing  | Low (manual resume for extended outages)      |
| Debugging              | Low    | Graduated logging           | Low (must sanitize sensitive data)            |

**Overall Assessment**: CLI-first approach is **viable** with these solutions. The main operational challenge is admin approval workflows for enterprise OAuth apps, which cannot be fully automated and require organizational coordination.

---

## 13. Progress Tracking & ETA

### 8.1 Sync Job Status Model

```typescript
interface SyncJob {
  jobId: string;
  connectorId: string;
  sourceType: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';

  // Progress tracking
  progress: {
    // Counts
    totalObjects: number | null; // null if unknown upfront
    processedObjects: number;
    successfulObjects: number;
    failedObjects: number;
    skippedObjects: number;

    // ETA
    startedAt: Date;
    estimatedCompletionAt: Date | null;

    // Current stage
    currentStage: 'discovery' | 'extraction' | 'chunking' | 'embedding' | 'indexing';
    currentObjectId: string | null;
    currentObjectName: string | null;

    // Throughput
    objectsPerMinute: number;
    averageProcessingTimeMs: number;
  };

  // Failure tracking
  failures: Array<{
    objectId: string;
    objectName: string;
    error: string;
    timestamp: Date;
    retryCount: number;
  }>;

  // Metadata
  syncType: 'full' | 'incremental';
  triggeredBy: 'schedule' | 'manual' | 'webhook';
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}
```

### 8.2 Progress Calculation

#### 8.2.1 Total Object Count Discovery

**Challenge**: Some APIs don't provide total count upfront (e.g., paginated APIs without count).

**Solution**: Multi-phase approach

```typescript
async function discoverTotalObjects(connector: IConnector): Promise<number | null> {
  // Phase 1: Try direct count API
  if (connector.supportsCount()) {
    const count = await connector.getTotalCount();
    if (count !== null) {
      return count;
    }
  }

  // Phase 2: Paginate and count (fast scan)
  let estimatedCount = 0;
  let hasMore = true;
  let cursor = null;
  let pageCount = 0;

  while (hasMore && pageCount < 10) {
    // Sample first 10 pages
    const page = await connector.listDocuments({ cursor, limit: 100 });
    estimatedCount += page.documents.length;
    cursor = page.nextCursor;
    hasMore = page.hasMore;
    pageCount++;
  }

  if (hasMore) {
    // Extrapolate based on average page size
    const avgPageSize = estimatedCount / pageCount;
    const estimatedTotalPages = await estimateRemainingPages(connector, cursor);
    return Math.floor(avgPageSize * estimatedTotalPages);
  }

  return estimatedCount;
}
```

**Update as we go**:

```typescript
async function updateProgressEstimate(job: SyncJob) {
  // If we didn't know total upfront, update estimate based on progress
  if (job.progress.totalObjects === null) {
    // Linear extrapolation
    const elapsedMs = Date.now() - job.progress.startedAt.getTime();
    const throughput = job.progress.processedObjects / (elapsedMs / 60000); // per minute

    // Assume we're X% done based on time elapsed vs typical sync duration
    const typicalDurationMinutes = await getTypicalSyncDuration(job.connectorId);
    const elapsedMinutes = elapsedMs / 60000;
    const percentComplete = Math.min(elapsedMinutes / typicalDurationMinutes, 0.95);

    const estimatedTotal = Math.floor(job.progress.processedObjects / percentComplete);

    await updateJob(job.jobId, {
      'progress.totalObjects': estimatedTotal,
    });
  }
}
```

#### 8.2.2 ETA Calculation

```typescript
function calculateETA(job: SyncJob): Date | null {
  if (job.progress.totalObjects === null) {
    return null; // Can't estimate without total
  }

  const remaining = job.progress.totalObjects - job.progress.processedObjects;
  if (remaining <= 0) {
    return new Date(); // Done
  }

  // Calculate throughput (exponential moving average)
  const currentThroughput = job.progress.objectsPerMinute;
  if (currentThroughput === 0) {
    return null; // No data yet
  }

  // Estimate remaining time
  const remainingMinutes = remaining / currentThroughput;

  // Add buffer for rate limiting and retries (1.2x multiplier)
  const bufferedMinutes = remainingMinutes * 1.2;

  const eta = new Date(Date.now() + bufferedMinutes * 60 * 1000);
  return eta;
}

// Update throughput with exponential moving average
function updateThroughput(job: SyncJob, newSample: number) {
  const alpha = 0.3; // Smoothing factor
  const newThroughput = alpha * newSample + (1 - alpha) * job.progress.objectsPerMinute;
  return newThroughput;
}
```

### 8.3 Real-Time Progress Updates

**WebSocket API** for live progress:

```typescript
// Client subscribes
ws.send(
  JSON.stringify({
    type: 'subscribe',
    jobId: 'job_abc123',
  }),
);

// Server sends updates every 5 seconds
setInterval(() => {
  const job = await getSyncJob(jobId);
  ws.send(
    JSON.stringify({
      type: 'progress',
      jobId: job.jobId,
      progress: {
        percent: (job.progress.processedObjects / job.progress.totalObjects) * 100,
        processed: job.progress.processedObjects,
        total: job.progress.totalObjects,
        failed: job.progress.failedObjects,
        eta: job.progress.estimatedCompletionAt,
        throughput: job.progress.objectsPerMinute,
        currentObject: job.progress.currentObjectName,
      },
    }),
  );
}, 5000);
```

**UI Display**:

```
┌─────────────────────────────────────────────────────────────┐
│ SharePoint Sync: "Corporate Intranet"                       │
├─────────────────────────────────────────────────────────────┤
│ Status: Running                                             │
│ Progress: [████████████░░░░░░░] 65% (6,500 / 10,000)        │
│ ETA: 15 minutes                                             │
│                                                             │
│ Current: Processing "Q4 Financial Report.docx"              │
│ Stage: Chunking                                             │
│ Throughput: 12.5 docs/min                                   │
│                                                             │
│ ✓ Successful: 6,200                                         │
│ ✗ Failed: 150 (view errors)                                 │
│ ⊘ Skipped: 150 (unchanged)                                  │
│                                                             │
│ [Pause] [View Logs] [Cancel]                                │
└─────────────────────────────────────────────────────────────┘
```

---

## 13. Failure Handling (Pause/Resume/Skip)

### 9.1 Failure Classification

```typescript
enum FailureType {
  // Transient (should retry)
  RATE_LIMIT = 'rate_limit', // 429 Too Many Requests
  NETWORK_ERROR = 'network_error', // Connection timeout, DNS
  TIMEOUT = 'timeout', // Request took too long
  SERVER_ERROR = 'server_error', // 500, 502, 503, 504

  // Permanent (should skip or fix)
  AUTH_ERROR = 'auth_error', // 401, 403
  NOT_FOUND = 'not_found', // 404
  INVALID_DATA = 'invalid_data', // Malformed response
  UNSUPPORTED_FORMAT = 'unsupported_format', // Can't parse this file type
  PERMISSION_DENIED = 'permission_denied', // User doesn't have access

  // System errors
  OUT_OF_MEMORY = 'out_of_memory',
  DISK_FULL = 'disk_full',
  UNKNOWN = 'unknown',
}

interface FailureMetadata {
  objectId: string;
  objectName: string;
  failureType: FailureType;
  error: string;
  httpStatus?: number;
  retryCount: number;
  timestamp: Date;
  stackTrace?: string;
}
```

### 9.2 Retry Strategy

```typescript
interface RetryPolicy {
  maxRetries: number;
  retryableFailures: FailureType[];
  backoffStrategy: 'exponential' | 'linear' | 'fixed';
  initialDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  retryableFailures: [
    FailureType.RATE_LIMIT,
    FailureType.NETWORK_ERROR,
    FailureType.TIMEOUT,
    FailureType.SERVER_ERROR,
  ],
  backoffStrategy: 'exponential',
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  jitterMs: 500,
};

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  failureType: FailureType,
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if retryable
      if (!policy.retryableFailures.includes(failureType)) {
        throw error;
      }

      // Check if we have retries left
      if (attempt === policy.maxRetries) {
        throw error;
      }

      // Calculate delay
      let delay: number;
      switch (policy.backoffStrategy) {
        case 'exponential':
          delay = Math.min(policy.initialDelayMs * Math.pow(2, attempt), policy.maxDelayMs);
          break;
        case 'linear':
          delay = Math.min(policy.initialDelayMs * (attempt + 1), policy.maxDelayMs);
          break;
        case 'fixed':
          delay = policy.initialDelayMs;
          break;
      }

      // Add jitter to prevent thundering herd
      delay += Math.random() * policy.jitterMs;

      logger.warn(`Retry attempt ${attempt + 1}/${policy.maxRetries} after ${delay}ms`, {
        error: error.message,
        failureType,
      });

      await sleep(delay);
    }
  }

  throw lastError;
}
```

### 9.3 Pause/Resume Implementation

```typescript
interface SyncJobCheckpoint {
  jobId: string;

  // Resumption state
  cursor: string | null; // Pagination cursor
  lastProcessedObjectId: string | null;
  lastProcessedAt: Date;

  // Progress snapshot
  processedCount: number;
  failedObjectIds: string[];

  // For incremental sync
  changeToken: string | null; // For APIs that support change tracking
}

// Pause job
async function pauseJob(jobId: string): Promise<void> {
  const job = await getSyncJob(jobId);

  // Create checkpoint
  const checkpoint: SyncJobCheckpoint = {
    jobId,
    cursor: job.currentCursor,
    lastProcessedObjectId: job.progress.currentObjectId,
    lastProcessedAt: new Date(),
    processedCount: job.progress.processedObjects,
    failedObjectIds: job.failures.map((f) => f.objectId),
    changeToken: job.changeToken,
  };

  await saveCheckpoint(checkpoint);

  // Update job status
  await updateJob(jobId, {
    status: 'paused',
    pausedAt: new Date(),
  });

  // Signal worker to stop
  await redisClient.publish(`sync-job:${jobId}:control`, 'PAUSE');

  logger.info(`Job paused`, { jobId, checkpoint });
}

// Resume job
async function resumeJob(jobId: string): Promise<void> {
  const job = await getSyncJob(jobId);

  if (job.status !== 'paused') {
    throw new Error(`Cannot resume job in status: ${job.status}`);
  }

  // Load checkpoint
  const checkpoint = await loadCheckpoint(jobId);

  // Update job to running
  await updateJob(jobId, {
    status: 'running',
    resumedAt: new Date(),
    currentCursor: checkpoint.cursor,
    'progress.currentObjectId': checkpoint.lastProcessedObjectId,
  });

  // Enqueue job with checkpoint
  await syncQueue.add('sync-job', {
    jobId,
    checkpoint,
  });

  logger.info(`Job resumed`, { jobId, checkpoint });
}

// Worker: Check for pause signal
async function processSyncJob(job: SyncJob, checkpoint?: SyncJobCheckpoint) {
  const pauseSignal = await redisClient.subscribe(`sync-job:${job.jobId}:control`);

  let cursor = checkpoint?.cursor || null;
  let processedCount = checkpoint?.processedCount || 0;

  while (true) {
    // Check for pause signal
    if (pauseSignal.message === 'PAUSE') {
      logger.info(`Received pause signal`, { jobId: job.jobId });
      return; // Exit worker
    }

    // Fetch next batch
    const result = await connector.listDocuments({ cursor, limit: 100 });

    for (const doc of result.documents) {
      // Process document
      try {
        await processDocument(doc);
        processedCount++;
      } catch (error) {
        await recordFailure(job.jobId, doc.id, error);
      }

      // Update progress every 10 docs
      if (processedCount % 10 === 0) {
        await updateJobProgress(job.jobId, {
          processedObjects: processedCount,
          currentObjectId: doc.id,
          currentCursor: cursor,
        });
      }
    }

    if (!result.hasMore) {
      break; // Sync complete
    }

    cursor = result.nextCursor;
  }

  // Mark job complete
  await updateJob(job.jobId, {
    status: 'completed',
    completedAt: new Date(),
  });
}
```

### 9.4 Skip Failed Documents

```typescript
// Admin UI: "Skip and Continue"
async function skipFailedDocuments(jobId: string, objectIds?: string[]): Promise<void> {
  const job = await getSyncJob(jobId);

  const failuresToSkip = objectIds
    ? job.failures.filter((f) => objectIds.includes(f.objectId))
    : job.failures; // Skip all failures

  // Mark as skipped
  await updateJob(jobId, {
    $pull: { failures: { objectId: { $in: failuresToSkip.map((f) => f.objectId) } } },
    $inc: { 'progress.skippedObjects': failuresToSkip.length },
  });

  // Log skip action
  logger.warn(`Skipped ${failuresToSkip.length} failed documents`, {
    jobId,
    skippedIds: failuresToSkip.map((f) => f.objectId),
  });

  // If job was failed due to too many errors, resume it
  if (job.status === 'failed') {
    await resumeJob(jobId);
  }
}

// Auto-skip: If >100 failures of same type, skip all and continue
async function autoSkipRepeatedFailures(job: SyncJob): Promise<void> {
  // Group failures by type
  const failuresByType = new Map<FailureType, FailureMetadata[]>();
  for (const failure of job.failures) {
    const list = failuresByType.get(failure.failureType) || [];
    list.push(failure);
    failuresByType.set(failure.failureType, list);
  }

  // Find types with >100 failures
  for (const [type, failures] of failuresByType) {
    if (failures.length > 100 && !isRetryableFailure(type)) {
      logger.warn(`Auto-skipping ${failures.length} failures of type ${type}`, {
        jobId: job.jobId,
        failureType: type,
      });

      await skipFailedDocuments(
        job.jobId,
        failures.map((f) => f.objectId),
      );
    }
  }
}
```

---

## 14. Intelligent Rate Limiting

### 10.1 Rate Limit Configuration

```typescript
interface RateLimitConfig {
  sourceType: string;

  // Limits
  requestsPerSecond?: number;
  requestsPerMinute?: number;
  requestsPerHour?: number;
  requestsPerDay?: number;

  // Burst allowance
  burstSize?: number; // Allow burst up to N requests

  // Scope
  scope: 'per-tenant' | 'per-user' | 'global';

  // Retry handling
  respectRetryAfterHeader: boolean;
  maxRetryAfterSeconds: number;

  // Concurrency
  maxConcurrentRequests?: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  sharepoint: {
    sourceType: 'sharepoint',
    requestsPerMinute: 600,
    burstSize: 100,
    scope: 'per-tenant',
    respectRetryAfterHeader: true,
    maxRetryAfterSeconds: 300,
    maxConcurrentRequests: 10,
  },

  jira: {
    sourceType: 'jira',
    requestsPerHour: 5000,
    scope: 'global', // Per IP
    respectRetryAfterHeader: true,
    maxRetryAfterSeconds: 600,
  },

  hubspot: {
    sourceType: 'hubspot',
    requestsPerSecond: 10,
    burstSize: 15,
    scope: 'per-tenant',
    respectRetryAfterHeader: true,
    maxRetryAfterSeconds: 60,
  },

  servicenow: {
    sourceType: 'servicenow',
    requestsPerHour: 1000,
    scope: 'per-tenant',
    respectRetryAfterHeader: false,
    maxConcurrentRequests: 5,
  },
};
```

### 10.2 Token Bucket Algorithm

```typescript
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async acquire(tokens: number = 1): Promise<void> {
    await this.refill();

    while (this.tokens < tokens) {
      const waitTime = ((tokens - this.tokens) / this.refillRate) * 1000;
      await sleep(waitTime);
      await this.refill();
    }

    this.tokens -= tokens;
  }

  private async refill(): Promise<void> {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  availableTokens(): number {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;
    return Math.min(this.capacity, this.tokens + tokensToAdd);
  }
}
```

### 10.3 Distributed Rate Limiter (Redis)

For multi-instance deployments, use Redis to share rate limit state:

```typescript
class DistributedRateLimiter {
  private redis: RedisClient;
  private config: RateLimitConfig;

  constructor(redis: RedisClient, config: RateLimitConfig) {
    this.redis = redis;
    this.config = config;
  }

  async acquire(key: string, tokens: number = 1): Promise<boolean> {
    const script = `
      local key = KEYS[1]
      local capacity = tonumber(ARGV[1])
      local refillRate = tonumber(ARGV[2])
      local tokens = tonumber(ARGV[3])
      local now = tonumber(ARGV[4])

      -- Get current state
      local state = redis.call('HMGET', key, 'tokens', 'lastRefill')
      local currentTokens = tonumber(state[1]) or capacity
      local lastRefill = tonumber(state[2]) or now

      -- Refill
      local elapsed = (now - lastRefill) / 1000
      currentTokens = math.min(capacity, currentTokens + elapsed * refillRate)

      -- Check if enough tokens
      if currentTokens >= tokens then
        currentTokens = currentTokens - tokens
        redis.call('HMSET', key, 'tokens', currentTokens, 'lastRefill', now)
        redis.call('EXPIRE', key, 3600) -- Expire after 1 hour of inactivity
        return 1
      else
        return 0
      end
    `;

    const rateLimitKey = this.getRateLimitKey(key);
    const capacity = this.config.burstSize || this.config.requestsPerSecond! * 60;
    const refillRate = this.calculateRefillRate();

    const result = await this.redis.eval(
      script,
      1,
      rateLimitKey,
      capacity,
      refillRate,
      tokens,
      Date.now(),
    );

    return result === 1;
  }

  private calculateRefillRate(): number {
    if (this.config.requestsPerSecond) {
      return this.config.requestsPerSecond;
    }
    if (this.config.requestsPerMinute) {
      return this.config.requestsPerMinute / 60;
    }
    if (this.config.requestsPerHour) {
      return this.config.requestsPerHour / 3600;
    }
    throw new Error('No rate limit configured');
  }

  private getRateLimitKey(key: string): string {
    const scope =
      this.config.scope === 'global'
        ? 'global'
        : this.config.scope === 'per-tenant'
          ? `tenant:${key}`
          : `user:${key}`;

    return `ratelimit:${this.config.sourceType}:${scope}`;
  }
}
```

### 10.4 Adaptive Rate Limiting

Automatically adjust rate based on API responses:

```typescript
class AdaptiveRateLimiter {
  private limiter: DistributedRateLimiter;
  private currentRate: number;
  private targetRate: number;
  private readonly minRate: number;
  private readonly maxRate: number;

  constructor(limiter: DistributedRateLimiter, targetRate: number) {
    this.limiter = limiter;
    this.targetRate = targetRate;
    this.currentRate = targetRate;
    this.minRate = targetRate * 0.1; // 10% of target
    this.maxRate = targetRate * 1.5; // 150% of target
  }

  async acquire(key: string): Promise<void> {
    const acquired = await this.limiter.acquire(key, 1);

    if (!acquired) {
      // Wait based on current rate
      const waitTime = 1000 / this.currentRate;
      await sleep(waitTime);
      return this.acquire(key); // Retry
    }
  }

  onSuccess(): void {
    // Gradually increase rate (additive increase)
    this.currentRate = Math.min(
      this.maxRate,
      this.currentRate + 1, // Add 1 req/sec
    );
  }

  onRateLimit(retryAfterSeconds?: number): void {
    // Aggressively decrease rate (multiplicative decrease)
    this.currentRate = Math.max(
      this.minRate,
      this.currentRate * 0.5, // Halve the rate
    );

    logger.warn(`Rate limited. Reduced rate to ${this.currentRate} req/sec`, {
      retryAfterSeconds,
    });

    if (retryAfterSeconds) {
      // Sleep for retry-after duration
      sleep(retryAfterSeconds * 1000);
    }
  }

  onError(): void {
    // Small decrease for other errors
    this.currentRate = Math.max(this.minRate, this.currentRate * 0.9);
  }
}
```

### 10.5 Batching Requests

Group requests to reduce API calls:

```typescript
class RequestBatcher<T, R> {
  private queue: Array<{
    input: T;
    resolve: (result: R) => void;
    reject: (error: Error) => void;
  }> = [];

  private batchSize: number;
  private batchWaitMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private batchFn: (inputs: T[]) => Promise<R[]>,
    options: { batchSize: number; batchWaitMs: number },
  ) {
    this.batchSize = options.batchSize;
    this.batchWaitMs = options.batchWaitMs;
  }

  async enqueue(input: T): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.queue.push({ input, resolve, reject });

      // Trigger batch if full
      if (this.queue.length >= this.batchSize) {
        this.flush();
      } else if (!this.timer) {
        // Set timer to flush after batchWaitMs
        this.timer = setTimeout(() => this.flush(), this.batchWaitMs);
      }
    });
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue.splice(0, this.batchSize);
    const inputs = batch.map((item) => item.input);

    try {
      const results = await this.batchFn(inputs);

      // Resolve each promise
      for (let i = 0; i < batch.length; i++) {
        batch[i].resolve(results[i]);
      }
    } catch (error) {
      // Reject all promises in batch
      for (const item of batch) {
        item.reject(error);
      }
    }
  }
}

// Usage: Batch permission checks
const permissionBatcher = new RequestBatcher(
  async (documentIds: string[]) => {
    // Batch API call
    return await graphClient.batch(
      documentIds.map((id) => ({ method: 'GET', url: `/documents/${id}/permissions` })),
    );
  },
  { batchSize: 50, batchWaitMs: 100 },
);

// Instead of individual calls
const perms1 = await getDocumentPermissions(doc1.id); // 1 API call
const perms2 = await getDocumentPermissions(doc2.id); // 1 API call
const perms3 = await getDocumentPermissions(doc3.id); // 1 API call

// Use batcher (only 1 API call total)
const [perms1, perms2, perms3] = await Promise.all([
  permissionBatcher.enqueue(doc1.id),
  permissionBatcher.enqueue(doc2.id),
  permissionBatcher.enqueue(doc3.id),
]);
```

---

## 15. Webhook Support

### 11.1 Webhook Endpoint

```typescript
// POST /api/webhooks/:sourceType/:connectorId
router.post('/webhooks/:sourceType/:connectorId', async (req, res) => {
  const { sourceType, connectorId } = req.params;
  const signature = req.headers['x-webhook-signature'] as string;

  // 1. Verify webhook signature
  const isValid = await verifyWebhookSignature(sourceType, signature, req.body);
  if (!isValid) {
    logger.warn(`Invalid webhook signature`, { sourceType, connectorId });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 2. Parse webhook event
  const event = await parseWebhookEvent(sourceType, req.body);

  // 3. Enqueue for processing (async)
  await webhookQueue.add('webhook-event', {
    connectorId,
    event,
    receivedAt: new Date(),
  });

  // 4. Return 200 immediately
  res.status(200).json({ status: 'queued' });
});
```

### 11.2 Webhook Event Types

```typescript
interface WebhookEvent {
  eventId: string;
  eventType: 'created' | 'updated' | 'deleted' | 'permission_changed';
  sourceType: string;
  objectId: string; // Document/issue/item ID in source system
  objectType: 'file' | 'issue' | 'article' | 'deal' | 'ticket';
  timestamp: Date;

  // Change details
  changes?: {
    field: string;
    oldValue: any;
    newValue: any;
  }[];

  // For permission changes
  permissionChanges?: {
    usersAdded: string[];
    usersRemoved: string[];
    groupsAdded: string[];
    groupsRemoved: string[];
  };
}
```

### 11.3 Webhook Processing

```typescript
async function processWebhookEvent(event: WebhookEvent): Promise<void> {
  logger.info(`Processing webhook event`, { eventType: event.eventType, objectId: event.objectId });

  switch (event.eventType) {
    case 'created':
      // Fetch new document and index
      await fetchAndIndexDocument(event.objectId);
      break;

    case 'updated':
      // Check if document exists in our index
      const existingDoc = await findDocumentBySourceId(event.objectId);
      if (existingDoc) {
        // Re-fetch and re-index
        await fetchAndIndexDocument(event.objectId);
      } else {
        // Document wasn't indexed before, index now
        await fetchAndIndexDocument(event.objectId);
      }
      break;

    case 'deleted':
      // Remove from index
      await deleteDocumentBySourceId(event.objectId);
      break;

    case 'permission_changed':
      // Update permissions only (don't re-index content)
      await updateDocumentPermissions(event.objectId, event.permissionChanges);
      break;
  }

  // Update last webhook received timestamp
  await updateConnector(event.connectorId, {
    lastWebhookReceivedAt: event.timestamp,
  });
}
```

### 11.4 Webhook Signature Verification

```typescript
// SharePoint webhook signature verification
async function verifySharePointWebhook(signature: string, body: any): Promise<boolean> {
  const clientState = body.value?.[0]?.clientState;
  const expectedClientState = await getConnectorSecret('sharepoint', 'clientState');
  return clientState === expectedClientState;
}

// Jira webhook signature verification
async function verifyJiraWebhook(signature: string, body: string): Promise<boolean> {
  const secret = await getConnectorSecret('jira', 'webhookSecret');
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(body).digest('hex');
  return signature === expectedSignature;
}

// HubSpot webhook signature verification
async function verifyHubSpotWebhook(
  signature: string,
  body: string,
  timestamp: string,
): Promise<boolean> {
  const secret = await getConnectorSecret('hubspot', 'appSecret');
  const payload = `${secret}${body}`;
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(timestamp + payload).digest('hex');
  return signature === expectedSignature;
}
```

### 11.5 Webhook Deduplication

Prevent duplicate processing when both webhook and scheduled sync find the same change:

```typescript
class WebhookDeduplicator {
  private redis: RedisClient;

  async recordProcessed(eventId: string, ttlSeconds: number = 3600): Promise<void> {
    const key = `webhook:processed:${eventId}`;
    await this.redis.setex(key, ttlSeconds, '1');
  }

  async isProcessed(eventId: string): Promise<boolean> {
    const key = `webhook:processed:${eventId}`;
    const exists = await this.redis.exists(key);
    return exists === 1;
  }

  async shouldProcess(event: WebhookEvent): Promise<boolean> {
    // Check if already processed
    if (await this.isProcessed(event.eventId)) {
      logger.debug(`Skipping duplicate webhook event`, { eventId: event.eventId });
      return false;
    }

    // Check if document was recently synced (within last 5 minutes)
    const doc = await findDocumentBySourceId(event.objectId);
    if (doc && doc.lastSyncedAt) {
      const ageMs = Date.now() - doc.lastSyncedAt.getTime();
      if (ageMs < 5 * 60 * 1000) {
        logger.debug(`Skipping webhook, document recently synced`, {
          eventId: event.eventId,
          lastSyncedAt: doc.lastSyncedAt,
        });
        return false;
      }
    }

    return true;
  }
}
```

### 11.6 Webhook Storm Handling

When a bulk operation triggers thousands of webhooks:

```typescript
class WebhookThrottler {
  private queue: WebhookEvent[] = [];
  private processing: boolean = false;

  async enqueue(event: WebhookEvent): Promise<void> {
    this.queue.push(event);

    // If queue is getting large, batch process
    if (this.queue.length > 100 && !this.processing) {
      await this.processBatch();
    }
  }

  private async processBatch(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      // Take up to 1000 events
      const batch = this.queue.splice(0, 1000);

      logger.info(`Processing webhook batch`, { count: batch.length });

      // Group by object ID (dedupe updates to same object)
      const byObjectId = new Map<string, WebhookEvent>();
      for (const event of batch) {
        const existing = byObjectId.get(event.objectId);
        if (!existing || event.timestamp > existing.timestamp) {
          byObjectId.set(event.objectId, event);
        }
      }

      // Process unique objects in parallel (with concurrency limit)
      await pMap(Array.from(byObjectId.values()), (event) => processWebhookEvent(event), {
        concurrency: 10,
      });
    } finally {
      this.processing = false;

      // Process remaining queue
      if (this.queue.length > 0) {
        setImmediate(() => this.processBatch());
      }
    }
  }
}
```

---

## 16. Incremental Sync & Real-Time Updates

### 12.1 Change Detection Strategies

Different APIs support different change detection methods:

| API            | Method               | How It Works                                                    | Granularity  |
| -------------- | -------------------- | --------------------------------------------------------------- | ------------ |
| **SharePoint** | Delta Query          | `GET /sites/{site}/drive/root/delta` returns only changed items | File-level   |
| **Jira**       | JQL Date Filter      | `updated >= '2024-01-01'`                                       | Issue-level  |
| **HubSpot**    | Recent Modified Date | `GET /crm/v3/objects/contacts?properties=lastmodifieddate`      | Object-level |
| **ServiceNow** | Change Token         | `sysparm_query=sys_updated_on>2024-01-01`                       | Record-level |

### 12.2 Sync State Tracking

```typescript
interface SyncState {
  connectorId: string;

  // For cursor-based pagination
  lastCursor: string | null;

  // For delta/change token APIs
  changeToken: string | null;
  deltaLink: string | null; // SharePoint delta URL

  // For timestamp-based sync
  lastSyncTimestamp: Date;

  // For permission sync
  lastPermissionSyncAt: Date;

  // Checksum for full validation
  lastFullSyncAt: Date;
  lastFullSyncChecksum: string | null;

  updatedAt: Date;
}
```

### 12.3 Incremental Sync Implementation

```typescript
async function performIncrementalSync(connector: IConnector): Promise<SyncResult> {
  const syncState = await getSyncState(connector.id);

  logger.info(`Starting incremental sync`, {
    connectorId: connector.id,
    lastSyncTimestamp: syncState.lastSyncTimestamp,
  });

  const changes = await connector.getChanges({
    since: syncState.lastSyncTimestamp,
    changeToken: syncState.changeToken,
    deltaLink: syncState.deltaLink,
  });

  let processed = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;

  for (const change of changes.items) {
    processed++;

    switch (change.changeType) {
      case 'created':
      case 'updated':
        // Check if content actually changed (hash-based)
        const existingDoc = await findDocumentBySourceId(change.id);
        const contentHash = await calculateContentHash(change.content);

        if (existingDoc && existingDoc.contentHash === contentHash) {
          // Content unchanged, skip re-indexing
          unchanged++;
          logger.debug(`Skipping unchanged document`, { id: change.id });
        } else {
          // Content changed or new, re-index
          await indexDocument(change);
          updated++;
        }
        break;

      case 'deleted':
        await deleteDocument(change.id);
        deleted++;
        break;
    }

    // Update progress
    if (processed % 100 === 0) {
      await updateSyncProgress(connector.id, { processed, updated, deleted, unchanged });
    }
  }

  // Save sync state
  await updateSyncState(connector.id, {
    lastSyncTimestamp: new Date(),
    changeToken: changes.nextChangeToken,
    deltaLink: changes.nextDeltaLink,
  });

  return { processed, updated, deleted, unchanged };
}
```

### 12.4 Permission Sync

Permissions can change independently of content. Sync them separately:

```typescript
async function syncPermissions(connector: IConnector): Promise<void> {
  logger.info(`Starting permission sync`, { connectorId: connector.id });

  // Get all documents from this connector
  const documents = await findDocumentsByConnector(connector.id);

  let updated = 0;

  for (const doc of documents) {
    // Fetch current permissions from source
    const currentPerms = await connector.getDocumentPermissions(doc.sourceDocumentId);

    // Compare with stored permissions
    const storedPerms = await getStoredPermissions(doc.id);

    if (!arePermissionsEqual(currentPerms, storedPerms)) {
      // Permissions changed, update
      await updateDocumentPermissions(doc.id, currentPerms);

      // Update OpenSearch ACL fields
      await updateOpenSearchACL(doc.id, currentPerms.acl);

      updated++;
      logger.info(`Updated permissions`, { documentId: doc.id });
    }
  }

  logger.info(`Permission sync complete`, { connectorId: connector.id, updated });
}

// Schedule permission sync every hour
cron.schedule('0 * * * *', async () => {
  const connectors = await getActiveConnectors();
  for (const connector of connectors) {
    await syncPermissions(connector);
  }
});
```

### 12.5 Full Validation Sync

Periodically do a full sync to catch missed changes:

```typescript
async function performFullValidationSync(connector: IConnector): Promise<void> {
  logger.info(`Starting full validation sync`, { connectorId: connector.id });

  // Fetch all document IDs from source
  const sourceDocIds = await connector.listAllDocumentIds();
  const sourceIdSet = new Set(sourceDocIds);

  // Fetch all document IDs from our index
  const indexedDocs = await findDocumentsByConnector(connector.id);
  const indexedIdSet = new Set(indexedDocs.map((d) => d.sourceDocumentId));

  // Find documents to add (in source but not in index)
  const toAdd = sourceDocIds.filter((id) => !indexedIdSet.has(id));

  // Find documents to remove (in index but not in source)
  const toRemove = indexedDocs.filter((d) => !sourceIdSet.has(d.sourceDocumentId));

  logger.info(`Full sync analysis`, {
    sourceCount: sourceDocIds.length,
    indexedCount: indexedDocs.length,
    toAdd: toAdd.length,
    toRemove: toRemove.length,
  });

  // Add missing documents
  for (const sourceId of toAdd) {
    await fetchAndIndexDocument(sourceId);
  }

  // Remove deleted documents
  for (const doc of toRemove) {
    await deleteDocument(doc.id);
  }

  // Save validation timestamp
  await updateSyncState(connector.id, {
    lastFullSyncAt: new Date(),
  });
}

// Schedule full validation weekly
cron.schedule('0 2 * * 0', async () => {
  const connectors = await getActiveConnectors();
  for (const connector of connectors) {
    await performFullValidationSync(connector);
  }
});
```

---

## 17. Data Reconciliation & Missing Content Detection

### 14.1 Problem Statement

**Challenge**: Data can go missing from the index due to:

1. **Incremental Sync Bugs**: Delta API returns incomplete results
2. **Webhook Failures**: Webhook not delivered, or our handler crashes
3. **Source System Bugs**: API returns inconsistent data
4. **Network Issues**: Transient failures during sync that weren't retried
5. **Race Conditions**: Document updated between fetch and index
6. **Permission Changes**: Document becomes inaccessible mid-sync
7. **Soft Deletes**: Document marked as deleted but webhook not sent

**Impact**: Users search for documents they know exist but get no results.

**Requirements**:

- ✅ Detect missing documents (in source but not in index)
- ✅ Detect orphaned documents (in index but deleted from source)
- ✅ Detect stale documents (indexed version older than source version)
- ✅ Automatically reconcile gaps
- ✅ Alert on large discrepancies
- ✅ Provide self-healing without manual intervention

### 14.2 Reconciliation Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│              DATA RECONCILIATION SYSTEM                           │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  1. CONTINUOUS MONITORING                                    │ │
│  ├─────────────────────────────────────────────────────────────┤ │
│  │  • Sample documents randomly (1% per hour)                   │ │
│  │  • Check if indexed version matches source version           │ │
│  │  • Track reconciliation metrics                              │ │
│  └─────────────────────────────────────────────────────────────┘ │
│         ↓ (anomaly detected)                                      │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  2. GAP DETECTION                                            │ │
│  ├─────────────────────────────────────────────────────────────┤ │
│  │  • Compare source document list vs indexed list              │ │
│  │  • Identify missing, orphaned, and stale documents           │ │
│  │  • Categorize by severity (critical, warning, info)          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│         ↓ (gaps found)                                            │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  3. AUTO-RECONCILIATION                                      │ │
│  ├─────────────────────────────────────────────────────────────┤ │
│  │  • Re-fetch and re-index missing documents                   │ │
│  │  • Delete orphaned documents                                 │ │
│  │  • Update stale documents                                    │ │
│  │  • Rate-limited to avoid overwhelming source                 │ │
│  └─────────────────────────────────────────────────────────────┘ │
│         ↓ (reconciliation complete)                               │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  4. REPORTING & ALERTING                                     │ │
│  ├─────────────────────────────────────────────────────────────┤ │
│  │  • Log reconciliation results                                │ │
│  │  • Alert if >5% documents missing                            │ │
│  │  • Dashboard showing reconciliation health                   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 14.3 Gap Detection

#### 14.3.1 Document Inventory Snapshot

```typescript
interface DocumentInventory {
  connectorId: string;
  snapshotAt: Date;

  // Source system inventory
  sourceDocuments: {
    id: string;
    version: string; // ETag, modifiedDate, or version number
    modifiedAt: Date;
  }[];

  // Our index inventory
  indexedDocuments: {
    id: string;
    version: string;
    indexedAt: Date;
    lastModifiedAt: Date;
  }[];

  // Gap analysis
  missingDocuments: string[]; // In source but not in index
  orphanedDocuments: string[]; // In index but not in source
  staleDocuments: string[]; // Indexed version < source version

  // Summary
  totalSourceDocuments: number;
  totalIndexedDocuments: number;
  consistencyScore: number; // 0-100%

  // Next reconciliation
  nextReconciliationAt: Date;
}
```

#### 14.3.2 Gap Detection Algorithm

```typescript
class GapDetector {
  async detectGaps(connectorId: string): Promise<GapAnalysis> {
    logger.info(`Starting gap detection`, { connectorId });

    // 1. Fetch source document inventory
    const sourceInventory = await this.fetchSourceInventory(connectorId);

    // 2. Fetch indexed document inventory
    const indexedInventory = await this.fetchIndexedInventory(connectorId);

    // 3. Build sets for comparison
    const sourceIds = new Set(sourceInventory.map((d) => d.id));
    const indexedIds = new Set(indexedInventory.map((d) => d.id));

    // 4. Find missing documents (in source but not indexed)
    const missingDocuments = sourceInventory.filter((d) => !indexedIds.has(d.id));

    // 5. Find orphaned documents (indexed but not in source)
    const orphanedDocuments = indexedInventory.filter((d) => !sourceIds.has(d.id));

    // 6. Find stale documents (version mismatch)
    const staleDocuments = [];
    const sourceMap = new Map(sourceInventory.map((d) => [d.id, d]));

    for (const indexedDoc of indexedInventory) {
      const sourceDoc = sourceMap.get(indexedDoc.id);
      if (sourceDoc && sourceDoc.version !== indexedDoc.version) {
        // Version mismatch, document is stale
        staleDocuments.push({
          id: indexedDoc.id,
          indexedVersion: indexedDoc.version,
          sourceVersion: sourceDoc.version,
          indexedAt: indexedDoc.indexedAt,
          sourceModifiedAt: sourceDoc.modifiedAt,
        });
      }
    }

    // 7. Calculate consistency score
    const totalSource = sourceInventory.length;
    const totalIndexed = indexedInventory.length;
    const inSync = totalSource - missingDocuments.length - staleDocuments.length;
    const consistencyScore = totalSource > 0 ? (inSync / totalSource) * 100 : 100;

    return {
      connectorId,
      snapshotAt: new Date(),
      missing: missingDocuments,
      orphaned: orphanedDocuments,
      stale: staleDocuments,
      consistencyScore,
      totalSourceDocuments: totalSource,
      totalIndexedDocuments: totalIndexed,
    };
  }

  private async fetchSourceInventory(connectorId: string): Promise<SourceDocument[]> {
    const connector = await getConnector(connectorId);
    const inventory: SourceDocument[] = [];

    // Paginate through all documents
    let cursor = null;
    do {
      const page = await connector.listDocuments({ cursor, limit: 1000 });

      for (const doc of page.documents) {
        inventory.push({
          id: doc.id,
          version: doc.version || doc.modifiedAt.toISOString(),
          modifiedAt: doc.modifiedAt,
        });
      }

      cursor = page.nextCursor;
    } while (cursor);

    return inventory;
  }

  private async fetchIndexedInventory(connectorId: string): Promise<IndexedDocument[]> {
    // Query MongoDB for all documents from this connector
    const documents = await Document.find(
      { connectorId },
      { sourceDocumentId: 1, version: 1, indexedAt: 1, lastModifiedAt: 1 },
    ).lean();

    return documents.map((d) => ({
      id: d.sourceDocumentId,
      version: d.version,
      indexedAt: d.indexedAt,
      lastModifiedAt: d.lastModifiedAt,
    }));
  }
}
```

### 14.4 Auto-Reconciliation

```typescript
class AutoReconciler {
  private readonly MAX_CONCURRENT_RECONCILIATIONS = 5;
  private readonly RECONCILIATION_RATE_LIMIT = 10; // per second

  async reconcile(gaps: GapAnalysis): Promise<ReconciliationResult> {
    logger.info(`Starting auto-reconciliation`, {
      connectorId: gaps.connectorId,
      missing: gaps.missing.length,
      orphaned: gaps.orphaned.length,
      stale: gaps.stale.length,
    });

    const result: ReconciliationResult = {
      connectorId: gaps.connectorId,
      startedAt: new Date(),
      missingReconciled: 0,
      orphanedRemoved: 0,
      staleUpdated: 0,
      failed: [],
      completedAt: null,
    };

    // 1. Reconcile missing documents (re-fetch and index)
    await this.reconcileMissing(gaps.missing, result);

    // 2. Remove orphaned documents
    await this.removeOrphaned(gaps.orphaned, result);

    // 3. Update stale documents
    await this.updateStale(gaps.stale, result);

    result.completedAt = new Date();

    // 4. Store reconciliation record
    await this.saveReconciliationRecord(result);

    // 5. Alert if reconciliation incomplete
    if (result.failed.length > 0) {
      await this.alertReconciliationFailures(result);
    }

    return result;
  }

  private async reconcileMissing(
    missing: SourceDocument[],
    result: ReconciliationResult,
  ): Promise<void> {
    if (missing.length === 0) return;

    logger.info(`Reconciling ${missing.length} missing documents`);

    // Process in batches with concurrency limit
    await pMap(
      missing,
      async (doc) => {
        try {
          await this.fetchAndIndexDocument(doc.id);
          result.missingReconciled++;
        } catch (error) {
          logger.error(`Failed to reconcile missing document`, {
            documentId: doc.id,
            error: error.message,
          });
          result.failed.push({
            documentId: doc.id,
            reason: 'reconcile_missing_failed',
            error: error.message,
          });
        }
      },
      { concurrency: this.MAX_CONCURRENT_RECONCILIATIONS },
    );
  }

  private async removeOrphaned(
    orphaned: IndexedDocument[],
    result: ReconciliationResult,
  ): Promise<void> {
    if (orphaned.length === 0) return;

    logger.info(`Removing ${orphaned.length} orphaned documents`);

    for (const doc of orphaned) {
      try {
        await this.deleteDocument(doc.id);
        result.orphanedRemoved++;
      } catch (error) {
        logger.error(`Failed to remove orphaned document`, {
          documentId: doc.id,
          error: error.message,
        });
        result.failed.push({
          documentId: doc.id,
          reason: 'remove_orphaned_failed',
          error: error.message,
        });
      }
    }
  }

  private async updateStale(stale: StaleDocument[], result: ReconciliationResult): Promise<void> {
    if (stale.length === 0) return;

    logger.info(`Updating ${stale.length} stale documents`);

    await pMap(
      stale,
      async (doc) => {
        try {
          await this.fetchAndIndexDocument(doc.id);
          result.staleUpdated++;
        } catch (error) {
          logger.error(`Failed to update stale document`, {
            documentId: doc.id,
            error: error.message,
          });
          result.failed.push({
            documentId: doc.id,
            reason: 'update_stale_failed',
            error: error.message,
          });
        }
      },
      { concurrency: this.MAX_CONCURRENT_RECONCILIATIONS },
    );
  }
}
```

### 14.5 Continuous Sampling

**Strategy**: Instead of full gap detection (expensive), continuously sample documents.

```typescript
class ContinuousSampler {
  private readonly SAMPLE_RATE = 0.01; // 1% of documents per hour
  private readonly SAMPLE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  async startSampling(connectorId: string): Promise<void> {
    setInterval(async () => {
      await this.sampleAndCheck(connectorId);
    }, this.SAMPLE_INTERVAL_MS);
  }

  private async sampleAndCheck(connectorId: string): Promise<void> {
    // Get total document count
    const totalDocuments = await Document.countDocuments({ connectorId });

    // Calculate sample size
    const sampleSize = Math.ceil(totalDocuments * this.SAMPLE_RATE);

    // Random sample
    const sample = await Document.aggregate([
      { $match: { connectorId } },
      { $sample: { size: sampleSize } },
      { $project: { sourceDocumentId: 1, version: 1, indexedAt: 1 } },
    ]);

    let inconsistencies = 0;

    for (const doc of sample) {
      try {
        // Fetch current version from source
        const sourceDoc = await connector.fetchDocument(doc.sourceDocumentId);

        // Compare versions
        if (sourceDoc.version !== doc.version) {
          inconsistencies++;
          logger.warn(`Sampled document is stale`, {
            documentId: doc.sourceDocumentId,
            indexedVersion: doc.version,
            sourceVersion: sourceDoc.version,
          });

          // Auto-reconcile
          await this.fetchAndIndexDocument(doc.sourceDocumentId);
        }
      } catch (error) {
        if (error.statusCode === 404) {
          // Document deleted from source
          logger.warn(`Sampled document no longer exists in source`, {
            documentId: doc.sourceDocumentId,
          });

          // Remove from index
          await this.deleteDocument(doc._id);
          inconsistencies++;
        } else {
          logger.error(`Failed to check sampled document`, {
            documentId: doc.sourceDocumentId,
            error: error.message,
          });
        }
      }
    }

    // Calculate inconsistency rate
    const inconsistencyRate = sampleSize > 0 ? (inconsistencies / sampleSize) * 100 : 0;

    // Alert if inconsistency rate is high
    if (inconsistencyRate > 5) {
      logger.error(`High inconsistency rate detected`, {
        connectorId,
        inconsistencyRate,
        sampleSize,
        inconsistencies,
      });

      // Trigger full gap detection
      await this.triggerFullGapDetection(connectorId);
    }

    // Record metric
    gauge('searchai_connector_consistency_rate', 100 - inconsistencyRate, {
      connector_id: connectorId,
    });
  }
}
```

### 14.6 Reconciliation Scheduling

```typescript
interface ReconciliationSchedule {
  connectorId: string;

  // Sampling
  continuousSamplingEnabled: boolean;
  sampleRate: number; // 0-1, default 0.01 (1%)

  // Full gap detection
  fullGapDetectionSchedule: string; // Cron expression, default '0 2 * * 0' (weekly)
  lastFullGapDetectionAt: Date;

  // Auto-reconciliation
  autoReconcileEnabled: boolean;
  reconciliationThreshold: number; // Trigger reconciliation if consistency < this %

  // Alerts
  alertThreshold: number; // Alert if consistency < this %
  alertChannels: string[]; // ['email', 'slack', 'pagerduty']
}

// Schedule full gap detection weekly
cron.schedule('0 2 * * 0', async () => {
  logger.info(`Running scheduled gap detection for all connectors`);

  const connectors = await getActiveConnectors();

  for (const connector of connectors) {
    try {
      const gaps = await gapDetector.detectGaps(connector.id);

      logger.info(`Gap detection complete`, {
        connectorId: connector.id,
        consistencyScore: gaps.consistencyScore,
        missing: gaps.missing.length,
        orphaned: gaps.orphaned.length,
        stale: gaps.stale.length,
      });

      // Auto-reconcile if consistency is low
      if (gaps.consistencyScore < 95) {
        logger.warn(`Low consistency score, triggering auto-reconciliation`, {
          connectorId: connector.id,
          consistencyScore: gaps.consistencyScore,
        });

        await autoReconciler.reconcile(gaps);
      }

      // Alert if very low
      if (gaps.consistencyScore < 90) {
        await alerting.send({
          severity: 'critical',
          title: `Low data consistency for connector ${connector.name}`,
          description: `Consistency score: ${gaps.consistencyScore}%. Missing: ${gaps.missing.length}, Orphaned: ${gaps.orphaned.length}, Stale: ${gaps.stale.length}`,
          connectorId: connector.id,
        });
      }
    } catch (error) {
      logger.error(`Gap detection failed`, {
        connectorId: connector.id,
        error: error.message,
      });
    }
  }
});
```

### 14.7 Reconciliation Dashboard

**Admin UI View**:

```
┌──────────────────────────────────────────────────────────────────┐
│ Data Reconciliation                                              │
├──────────────────────────────────────────────────────────────────┤
│ Connector: SharePoint Production                                 │
│ Last Gap Detection: 2 hours ago                                  │
│ Consistency Score: 98.5%                                         │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Missing Documents:    42                                    │  │
│ │ Orphaned Documents:   15                                    │  │
│ │ Stale Documents:      28                                    │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ Auto-Reconciliation: ✓ Enabled                                  │
│ Last Reconciliation: 3 hours ago                                │
│ Reconciled: 38 missing, 12 orphaned, 25 stale                   │
│ Failed: 5 (view errors)                                         │
│                                                                  │
│ [Run Manual Gap Detection] [Reconcile Now] [View History]       │
└──────────────────────────────────────────────────────────────────┘
```

### 14.8 Reconciliation Metrics

```typescript
// Prometheus metrics
gauge('searchai_connector_consistency_score', 'Data consistency score 0-100', ['connector_id']);
gauge('searchai_connector_missing_documents', 'Documents missing from index', ['connector_id']);
gauge('searchai_connector_orphaned_documents', 'Documents orphaned in index', ['connector_id']);
gauge('searchai_connector_stale_documents', 'Documents with stale versions', ['connector_id']);

counter('searchai_reconciliation_runs', 'Reconciliation runs', ['connector_id', 'type']);
counter('searchai_reconciliation_documents_fixed', 'Documents reconciled', [
  'connector_id',
  'fix_type',
]);
counter('searchai_reconciliation_failures', 'Reconciliation failures', ['connector_id', 'reason']);

histogram('searchai_gap_detection_duration', 'Gap detection duration', ['connector_id']);
histogram('searchai_reconciliation_duration', 'Reconciliation duration', ['connector_id']);
```

### 14.9 Testing Reconciliation

**Simulate missing data scenario**:

```typescript
describe('Data Reconciliation', () => {
  it('should detect and reconcile missing documents', async () => {
    // 1. Sync 100 documents
    await syncConnector(connectorId);

    // 2. Verify all indexed
    const indexed = await Document.countDocuments({ connectorId });
    expect(indexed).toBe(100);

    // 3. Manually delete 10 documents from index (simulate bug)
    await Document.deleteMany({ connectorId, _id: { $in: deleteIds } });

    // 4. Run gap detection
    const gaps = await gapDetector.detectGaps(connectorId);
    expect(gaps.missing.length).toBe(10);

    // 5. Run reconciliation
    const result = await autoReconciler.reconcile(gaps);
    expect(result.missingReconciled).toBe(10);

    // 6. Verify all re-indexed
    const reindexed = await Document.countDocuments({ connectorId });
    expect(reindexed).toBe(100);
  });

  it('should remove orphaned documents', async () => {
    // 1. Sync 100 documents
    await syncConnector(connectorId);

    // 2. Delete 10 documents from source
    await connector.deleteDocuments(deleteIds);

    // 3. Run gap detection
    const gaps = await gapDetector.detectGaps(connectorId);
    expect(gaps.orphaned.length).toBe(10);

    // 4. Run reconciliation
    const result = await autoReconciler.reconcile(gaps);
    expect(result.orphanedRemoved).toBe(10);

    // 5. Verify removed from index
    const remaining = await Document.countDocuments({ connectorId });
    expect(remaining).toBe(90);
  });
});
```

---

## 18. Observability & Monitoring

### 13.1 Metrics

**Key Performance Indicators (KPIs)**:

```typescript
// Sync metrics
gauge('searchai_sync_active_jobs', 'Number of active sync jobs');
gauge('searchai_sync_queue_depth', 'Number of queued sync jobs');
histogram('searchai_sync_duration_seconds', 'Sync job duration');
counter('searchai_sync_documents_processed', 'Documents processed by sync jobs');
counter('searchai_sync_documents_failed', 'Documents that failed to sync');
gauge('searchai_sync_throughput', 'Documents per minute');

// Connector metrics
gauge('searchai_connector_total_documents', 'Total documents by connector', ['connector_id']);
gauge('searchai_connector_sync_lag_seconds', 'Time since last sync', ['connector_id']);
counter('searchai_connector_api_requests', 'API requests to source', ['connector_id', 'status']);
histogram('searchai_connector_api_latency', 'API request latency', ['connector_id']);

// Permission metrics
counter('searchai_permission_checks', 'Permission checks performed');
histogram('searchai_permission_check_duration', 'Permission check duration');
gauge('searchai_permission_cache_hit_rate', 'Permission cache hit rate');

// Search metrics
counter('searchai_searches', 'Search requests', ['index_id']);
histogram('searchai_search_latency', 'Search latency', ['index_id']);
histogram('searchai_search_results_returned', 'Number of results returned');
counter('searchai_search_zero_results', 'Searches with zero results', ['index_id']);
gauge('searchai_search_permission_filtered_pct', 'Percentage of results filtered by permissions');

// Activity tracking metrics
counter('searchai_user_activities', 'User activities tracked', ['activity_type']);
gauge('searchai_active_users_24h', 'Active users in last 24 hours');
```

### 13.2 Structured Logging

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  base: {
    service: 'searchai-connector',
    environment: process.env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Usage
logger.info(
  {
    event: 'sync_started',
    connectorId: connector.id,
    sourceType: connector.sourceType,
    syncType: 'incremental',
    triggeredBy: 'schedule',
  },
  'Starting incremental sync',
);

logger.error(
  {
    event: 'document_processing_failed',
    connectorId: connector.id,
    documentId: doc.id,
    documentName: doc.name,
    error: error.message,
    stack: error.stack,
    retryCount: 2,
  },
  'Failed to process document',
);
```

### 13.3 Distributed Tracing

Use OpenTelemetry for end-to-end tracing:

```typescript
import { trace, context } from '@opentelemetry/api';

const tracer = trace.getTracer('searchai-connector');

async function syncDocument(documentId: string) {
  const span = tracer.startSpan('sync_document', {
    attributes: {
      'document.id': documentId,
    },
  });

  try {
    // Fetch
    const fetchSpan = tracer.startSpan(
      'fetch_from_source',
      {},
      trace.setSpan(context.active(), span),
    );
    const rawDoc = await connector.fetchDocument(documentId);
    fetchSpan.end();

    // Extract
    const extractSpan = tracer.startSpan(
      'extract_content',
      {},
      trace.setSpan(context.active(), span),
    );
    const extracted = await extractContent(rawDoc);
    extractSpan.end();

    // Chunk
    const chunkSpan = tracer.startSpan('chunk_document', {}, trace.setSpan(context.active(), span));
    const chunks = await chunkDocument(extracted);
    chunkSpan.end();

    // Embed
    const embedSpan = tracer.startSpan(
      'generate_embeddings',
      {},
      trace.setSpan(context.active(), span),
    );
    const embeddings = await generateEmbeddings(chunks);
    embedSpan.end();

    // Index
    const indexSpan = tracer.startSpan(
      'index_to_opensearch',
      {},
      trace.setSpan(context.active(), span),
    );
    await indexToOpenSearch(embeddings);
    indexSpan.end();

    span.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    throw error;
  } finally {
    span.end();
  }
}
```

### 13.4 Health Checks

```typescript
// GET /health
router.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    checks: {
      mongodb: await checkMongoDB(),
      redis: await checkRedis(),
      opensearch: await checkOpenSearch(),
      syncWorkers: await checkSyncWorkers(),
    },
  };

  const isHealthy = Object.values(health.checks).every((check) => check.status === 'up');
  health.status = isHealthy ? 'healthy' : 'degraded';

  res.status(isHealthy ? 200 : 503).json(health);
});

async function checkMongoDB(): Promise<HealthCheck> {
  try {
    await mongoose.connection.db.admin().ping();
    return { status: 'up', latencyMs: 5 };
  } catch (error) {
    return { status: 'down', error: error.message };
  }
}
```

### 13.5 Alerting Rules

```yaml
# Prometheus alerting rules
groups:
  - name: searchai_sync
    rules:
      - alert: SyncJobStuck
        expr: searchai_sync_active_jobs > 0 and rate(searchai_sync_documents_processed[5m]) == 0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: 'Sync job appears stuck'
          description: 'Connector {{ $labels.connector_id }} has been syncing for >10m with no progress'

      - alert: HighSyncFailureRate
        expr: rate(searchai_sync_documents_failed[5m]) / rate(searchai_sync_documents_processed[5m]) > 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: 'High sync failure rate'
          description: 'More than 10% of documents failing to sync for connector {{ $labels.connector_id }}'

      - alert: PermissionCacheMiss
        expr: searchai_permission_cache_hit_rate < 0.7
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'Low permission cache hit rate'
          description: 'Permission cache hit rate is {{ $value }}%, causing slower searches'

      - alert: ConnectorSyncLag
        expr: searchai_connector_sync_lag_seconds > 3600
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: 'Connector sync lagging'
          description: "Connector {{ $labels.connector_id }} hasn't synced in over 1 hour"
```

### 13.6 Admin Dashboard

Key views for monitoring connector health:

**1. Sync Overview**:

```
┌──────────────────────────────────────────────────────────────┐
│ Sync Jobs (Last 24h)                                         │
├──────────────────────────────────────────────────────────────┤
│ Total: 145      ✓ Success: 132      ✗ Failed: 8             │
│ Active: 5       ⏸ Paused: 2         ⏱ Queued: 3              │
│                                                              │
│ Throughput: 1,250 docs/min                                   │
│ Avg Duration: 12m 34s                                        │
└──────────────────────────────────────────────────────────────┘
```

**2. Connector Health**:

```
┌────────────────────────────────────────────────────────────────┐
│ Connector       │ Status  │ Last Sync  │ Docs    │ Error Rate │
├────────────────────────────────────────────────────────────────┤
│ SharePoint Prod │ ✓ Healthy│ 5m ago     │ 125,432 │ 0.1%      │
│ Jira Company    │ ⚠ Warning│ 2h ago     │  45,231 │ 2.5%      │
│ HubSpot CRM     │ ✓ Healthy│ 10m ago    │  12,543 │ 0.0%      │
│ ServiceNow IT   │ ✗ Error  │ 1d ago     │   8,432 │ 15.3%     │
└────────────────────────────────────────────────────────────────┘
```

**3. Recent Failures**:

```
┌──────────────────────────────────────────────────────────────┐
│ Time      │ Connector    │ Document              │ Error    │
├──────────────────────────────────────────────────────────────┤
│ 2m ago    │ SharePoint   │ large_file.zip        │ Timeout  │
│ 5m ago    │ Jira         │ PROJ-1234             │ 401 Auth │
│ 12m ago   │ ServiceNow   │ INC0012345            │ Rate Limit│
└──────────────────────────────────────────────────────────────┘
```

**4. Search Analytics**:

```
┌──────────────────────────────────────────────────────────────┐
│ Searches Today: 5,432                                         │
│ Avg Latency: 245ms                                           │
│ Zero Results: 3.2%                                           │
│ Permission Filtered: 12.5% of candidates                     │
│                                                              │
│ Top Searches:                                                │
│ 1. "q4 financial report"         (234 searches)              │
│ 2. "employee handbook"            (187 searches)              │
│ 3. "api documentation"            (142 searches)              │
└──────────────────────────────────────────────────────────────┘
```

---

## 19. Data Models

### 14.1 MongoDB Collections

**connectors**:

```typescript
{
  _id: string,
  tenantId: string,
  name: string,
  sourceType: 'sharepoint' | 'jira' | 'hubspot' | 'servicenow',

  // Connection config (encrypted at rest)
  connectionConfig: {
    authType: 'oauth' | 'api_key' | 'basic',
    credentials: encrypted_json, // Encrypted with KMS
    baseUrl: string,
    // Source-specific config
  },

  // Sync configuration
  syncSchedule: string, // Cron expression
  syncEnabled: boolean,
  lastSyncAt: Date,
  nextSyncAt: Date,

  // Webhook config
  webhookEnabled: boolean,
  webhookUrl: string,
  webhookSecret: string,

  // Filter configuration (Section 9)
  filterConfig: {
    enabled: boolean,
    commonFilters: {
      modifiedAfter: Date,
      modifiedBefore: Date,
      maxSizeBytes: number,
      includeContentTypes: [string],
      excludeContentTypes: [string],
      includeFileExtensions: [string],
      excludeFileExtensions: [string]
    },
    sourceSpecificFilters: object // Jira, Confluence, SharePoint-specific filters
  },

  // Permission crawling configuration (Section 10)
  permissionConfig: {
    enabled: boolean,
    mode: 'full' | 'simplified' | 'disabled',
    fullModeConfig: {
      includeGroups: boolean,
      includeInheritance: boolean,
      cachePermissions: boolean,
      cacheTTL: number
    },
    simplifiedModeConfig: {
      assumeInheritance: boolean,
      onlyCheckParentPermissions: boolean,
      sampleRate: number
    },
    disabledModeConfig: {
      defaultVisibility: 'public' | 'authenticated' | 'private',
      staticACL: {
        users: [string],
        groups: [string],
        roles: [string]
      }
    },
    performanceConfig: {
      maxConcurrentPermissionCalls: number,
      permissionCallTimeoutMs: number,
      skipPermissionsOnTimeout: boolean
    }
  },

  // Status
  status: 'active' | 'paused' | 'error',
  errorMessage: string,

  // Metrics
  totalDocuments: number,
  totalFilteredDocuments: number, // Documents excluded by filters
  lastSyncDuration: number,
  permissionCrawlingOverhead: number, // Percentage of sync time spent on permissions

  createdAt: Date,
  updatedAt: Date
}
```

**sync_jobs**:

```typescript
{
  _id: string,
  connectorId: string,
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed',

  syncType: 'full' | 'incremental',
  triggeredBy: 'schedule' | 'manual' | 'webhook',

  progress: {
    totalObjects: number,
    processedObjects: number,
    successfulObjects: number,
    failedObjects: number,
    skippedObjects: number,
    currentStage: string,
    currentObjectId: string,
    objectsPerMinute: number,
    estimatedCompletionAt: Date
  },

  failures: [{
    objectId: string,
    objectName: string,
    error: string,
    failureType: string,
    retryCount: number,
    timestamp: Date
  }],

  syncState: {
    lastCursor: string,
    changeToken: string,
    deltaLink: string,
    lastSyncTimestamp: Date
  },

  startedAt: Date,
  completedAt: Date,
  createdAt: Date,
  updatedAt: Date
}
```

**document_permissions**:

```typescript
{
  _id: string,
  documentId: string, // Reference to document in OpenSearch
  sourceType: string,
  sourceDocumentId: string,

  acl: {
    users: [string],
    groups: [string],
    roles: [string],
    visibility: 'private' | 'authenticated' | 'public'
  },

  inheritedFrom: string,
  permissionVersion: number,
  lastSyncedAt: Date,

  createdAt: Date,
  updatedAt: Date
}
```

**user_identity_mappings**:

```typescript
{
  _id: string,
  searchUserId: string,
  searchUserEmail: string,
  tenantId: string,

  mappings: [{
    sourceType: string,
    sourceUserId: string,
    sourceUserEmail: string,
    groups: [string],
    roles: [string],
    lastSyncedAt: Date
  }],

  createdAt: Date,
  updatedAt: Date
}
```

**user_activities**:

```typescript
{
  _id: string,
  userId: string,
  documentId: string,
  sourceType: string,

  activities: {
    viewed: { count: number, lastAt: Date },
    edited: { count: number, lastAt: Date },
    commented: { count: number, lastAt: Date },
    shared: { count: number, lastAt: Date },
    starred: { count: number, lastAt: Date }
  },

  activityScore: number,
  lastUpdated: Date
}
```

**user_relationships**:

```typescript
{
  _id: string,
  userId: string,
  tenantId: string,

  manager: string,
  directReports: [string],
  peers: [string],

  frequentCollaborators: [{
    userId: string,
    collaborationScore: number
  }],

  teams: [string],
  departments: [string],

  lastUpdated: Date
}
```

### 14.2 OpenSearch Index Schema

```json
{
  "mappings": {
    "properties": {
      "document_id": { "type": "keyword" },
      "tenant_id": { "type": "keyword" },
      "index_id": { "type": "keyword" },
      "source_type": { "type": "keyword" },
      "source_document_id": { "type": "keyword" },

      "title": { "type": "text", "analyzer": "standard" },
      "content": { "type": "text", "analyzer": "standard" },
      "summary": { "type": "text" },

      "vector": {
        "type": "knn_vector",
        "dimension": 1024,
        "method": {
          "name": "hnsw",
          "space_type": "cosinesimil",
          "engine": "nmslib"
        }
      },

      "acl_users": { "type": "keyword" },
      "acl_groups": { "type": "keyword" },
      "acl_roles": { "type": "keyword" },
      "acl_visibility": { "type": "keyword" },

      "author": { "type": "keyword" },
      "created_date": { "type": "date" },
      "modified_date": { "type": "date" },

      "document_type": { "type": "keyword" },
      "mime_type": { "type": "keyword" },
      "file_size": { "type": "long" },

      "metadata": { "type": "object", "enabled": false },

      "indexed_at": { "type": "date" }
    }
  }
}
```

---

## 20. API Specification

### 15.1 Connector Management

**Create Connector**:

```http
POST /api/connectors
Authorization: Bearer <token>

{
  "name": "Corporate SharePoint",
  "sourceType": "sharepoint",
  "connectionConfig": {
    "authType": "oauth",
    "tenantId": "contoso.onmicrosoft.com",
    "clientId": "...",
    "clientSecret": "..."
  },
  "syncSchedule": "0 */6 * * *", // Every 6 hours
  "syncEnabled": true,
  "webhookEnabled": true
}
```

**Response**:

```json
{
  "connectorId": "conn_abc123",
  "status": "active",
  "webhookUrl": "https://api.searchai.com/webhooks/sharepoint/conn_abc123"
}
```

**Trigger Manual Sync**:

```http
POST /api/connectors/:connectorId/sync
Authorization: Bearer <token>

{
  "syncType": "incremental" // or "full"
}
```

**Response**:

```json
{
  "jobId": "job_xyz789",
  "status": "queued",
  "estimatedDuration": "15m"
}
```

### 15.2 Sync Job Management

**Get Job Status**:

```http
GET /api/sync-jobs/:jobId
Authorization: Bearer <token>
```

**Response**:

```json
{
  "jobId": "job_xyz789",
  "connectorId": "conn_abc123",
  "status": "running",
  "progress": {
    "totalObjects": 10000,
    "processedObjects": 6500,
    "successfulObjects": 6200,
    "failedObjects": 150,
    "skippedObjects": 150,
    "percentComplete": 65,
    "currentStage": "chunking",
    "currentObject": "Q4 Financial Report.docx",
    "throughput": 12.5,
    "estimatedCompletionAt": "2024-02-23T15:45:00Z"
  },
  "failures": [
    /* ... */
  ]
}
```

**Pause Job**:

```http
POST /api/sync-jobs/:jobId/pause
```

**Resume Job**:

```http
POST /api/sync-jobs/:jobId/resume
```

**Skip Failed Documents**:

```http
POST /api/sync-jobs/:jobId/skip
{
  "objectIds": ["doc1", "doc2"] // Optional, skips all if omitted
}
```

### 15.3 Search API

**Search with User Context**:

```http
POST /api/search/:indexId/query
Authorization: Bearer <token> // User JWT token

{
  "query": "quarterly financial report",
  "top_k": 10,
  "filters": {
    "created_date": { "gte": "2024-01-01" }
  },
  "boost": {
    "userActivity": true,
    "relationships": true
  }
}
```

**Response**:

```json
{
  "results": [
    {
      "documentId": "doc_123",
      "title": "Q4 2024 Financial Report",
      "snippet": "...quarterly revenue increased by 42%...",
      "score": 0.89,
      "source": {
        "type": "sharepoint",
        "url": "https://contoso.sharepoint.com/docs/q4-2024.pdf"
      },
      "metadata": {
        "author": "Jane Doe",
        "created_date": "2024-12-15",
        "file_size": 2456789
      },
      "boosted": {
        "userActivity": 1.2, // User viewed this before
        "relationship": 1.5 // Authored by user's manager
      }
    }
  ],
  "total": 142,
  "took": 245,
  "permissionFiltered": 58 // Candidates filtered due to permissions
}
```

---

## 21. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)

**Goals**: Core infrastructure and data models

- [ ] Define MongoDB schemas (connectors, sync_jobs, permissions, user_mappings)
- [ ] Define OpenSearch index schema with ACL fields
- [ ] Implement base `IConnector` interface
- [ ] Implement sync orchestrator skeleton
- [ ] Implement rate limiter (Token bucket + Redis)
- [ ] Set up BullMQ for job queue
- [ ] Basic observability (logging, metrics)

**Deliverable**: Empty connector interface + job queue + rate limiter

---

### Phase 2: SharePoint Connector (Weeks 3-4)

**Goals**: First fully functional connector with permissions

- [ ] Implement SharePoint OAuth flow
- [ ] Implement SharePoint document listing (Graph API)
- [ ] Implement SharePoint permission extraction
- [ ] Implement content fetching (files, pages)
- [ ] Implement delta query (incremental sync)
- [ ] Implement webhook endpoint + signature verification
- [ ] Test with real SharePoint tenant

**Deliverable**: SharePoint connector with full + incremental sync + webhooks

---

### Phase 3: Permission Enforcement (Week 5)

**Goals**: Query-time permission filtering

- [ ] Implement user identity resolver
- [ ] Implement ACL filter builder
- [ ] Integrate ACL filter into search query
- [ ] Implement permission cache (Redis)
- [ ] Permission sync job (hourly)
- [ ] Test with multiple users and permission scenarios

**Deliverable**: Search respects user permissions

---

### Phase 4: Jira Connector (Week 6)

**Goals**: Structured data connector (issues, comments)

- [ ] Implement Jira OAuth flow
- [ ] Implement Jira issue listing + pagination
- [ ] Implement issue permission extraction (project + scheme)
- [ ] Implement issue document model (denormalized)
- [ ] Implement JQL-based incremental sync
- [ ] Implement Jira webhook handling
- [ ] Test with real Jira instance

**Deliverable**: Jira connector with issues indexed

---

### Phase 5: Progress Tracking & Failure Handling (Week 7)

**Goals**: Robust sync with visibility

- [ ] Implement progress tracker with ETA
- [ ] Implement failure classifier
- [ ] Implement retry with exponential backoff
- [ ] Implement pause/resume/skip
- [ ] Implement checkpoint/resume logic
- [ ] WebSocket API for real-time progress
- [ ] Admin dashboard UI (React components)

**Deliverable**: Full visibility into sync status + failure recovery

---

### Phase 6: HubSpot & ServiceNow Connectors (Weeks 8-9)

**Goals**: CRM + ITSM connectors

- [ ] Implement HubSpot connector (deals, contacts, tickets)
- [ ] Implement HubSpot activity tracking
- [ ] Implement ServiceNow connector (incidents, KB articles)
- [ ] Implement ServiceNow ACL evaluation
- [ ] Test all 4 connectors in parallel
- [ ] Load testing (10k+ documents per connector)

**Deliverable**: 4 production-ready connectors

---

### Phase 7: User Activity & Relationship Tracking (Week 10)

**Goals**: Intelligent boosting

- [ ] Implement activity tracker
- [ ] Implement relationship graph builder
- [ ] Sync activity from source systems
- [ ] Implement query-time boosting (activity + relationships)
- [ ] Privacy controls (consent, deletion)
- [ ] Test boosting effectiveness (A/B test)

**Deliverable**: Search results boosted by user context

---

### Phase 8: Polish & Documentation (Week 11-12)

**Goals**: Production readiness

- [ ] Comprehensive error messages
- [ ] Admin documentation
- [ ] Developer guide for adding new connectors
- [ ] Security audit
- [ ] Performance optimization
- [ ] Scale testing (1M+ documents)
- [ ] Deployment automation (Terraform/K8s)

**Deliverable**: Production-ready system with documentation

---

## Appendix A: Connector Interface

```typescript
interface IConnector {
  readonly id: string;
  readonly sourceType: string;
  readonly name: string;

  // Authentication
  authenticate(credentials: any): Promise<void>;
  refreshAuth(): Promise<void>;

  // Discovery
  supportsCount(): boolean;
  getTotalCount(): Promise<number | null>;
  listDocuments(options: ListOptions): Promise<ListResult>;
  getChanges(options: ChangesOptions): Promise<ChangeResult>;

  // Fetching
  fetchDocument(documentId: string): Promise<RawDocument>;
  fetchDocumentBatch(documentIds: string[]): Promise<RawDocument[]>;

  // Permissions
  extractPermissions(documentId: string): Promise<DocumentPermissions>;

  // User info
  getUserGroups(userId: string): Promise<string[]>;
  getUserProfile(userId: string): Promise<UserProfile>;

  // Activity
  getDocumentActivity(documentId: string): Promise<ActivityLog[]>;

  // Webhooks
  supportsWebhooks(): boolean;
  registerWebhook(callbackUrl: string): Promise<void>;
  unregisterWebhook(): Promise<void>;
  verifyWebhookSignature(signature: string, body: any): boolean;
  parseWebhookEvent(body: any): WebhookEvent;

  // Metadata
  getSchema(): Promise<ConnectorSchema>;
}
```

---

## Appendix B: Security Checklist

- [ ] All credentials encrypted at rest (AES-256-GCM with KMS)
- [ ] Credentials never logged
- [ ] TLS 1.3 for all external API calls
- [ ] Webhook signature verification mandatory
- [ ] User permissions verified at query time (never cached without TTL)
- [ ] Activity tracking requires explicit user consent
- [ ] Personal data retention policy enforced (365 days)
- [ ] Right to erasure implemented (GDPR compliance)
- [ ] Rate limiting prevents abuse
- [ ] Input validation on all API endpoints
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (sanitize outputs)
- [ ] CSRF protection on state-changing endpoints
- [ ] Audit logging for all sensitive operations
- [ ] Secrets rotation mechanism
- [ ] Least privilege principle for service accounts
- [ ] Regular security audits and penetration testing

---

**End of Document**

Total Pages: ~70
Total Words: ~25,000
Last Updated: 2026-02-23

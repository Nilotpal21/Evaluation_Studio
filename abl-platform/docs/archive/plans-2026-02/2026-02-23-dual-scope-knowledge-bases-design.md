# Dual-Scope Knowledge Bases: Cross-Project Search Index Sharing

**Date**: 2026-02-23
**Status**: Draft
**Authors**: Prasanna Arikala
**Scope**: Knowledge base scoping model, cross-project sharing, RBAC, promotion workflow
**Related**:

- [Project-Level RBAC Design](2026-02-20-project-level-rbac-design.md) — project-scoped permission model this design extends
- [Centralized Auth Design](2026-02-22-centralized-auth-design.md) — auth context types used for permission checks
- [Attachment Pipeline Design](2026-02-21-attachment-pipeline-design.md) — file ingestion flow that feeds into knowledge bases
- [PDF-KB Integration Design](2026-02-22-pdf-kb-integration-design.md) — multimodal document processing for KB ingestion

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current Architecture](#2-current-architecture)
3. [Design Goals](#3-design-goals)
4. [Solution: Dual-Scope Model](#4-solution-dual-scope-model)
5. [Data Model Changes](#5-data-model-changes)
6. [Knowledge Base Assignment](#6-knowledge-base-assignment)
7. [Domain Vocabulary Scoping](#7-domain-vocabulary-scoping)
8. [KB Promotion: Project to Tenant](#8-kb-promotion-project-to-tenant)
9. [RBAC Permission Model](#9-rbac-permission-model)
10. [API Route Design](#10-api-route-design)
11. [Query Patterns & Authorization](#11-query-patterns--authorization)
12. [Admin UX](#12-admin-ux)
13. [Migration Strategy](#13-migration-strategy)
14. [Testing Strategy](#14-testing-strategy)
15. [Design Decisions](#15-design-decisions)
16. [Files Changed](#16-files-changed)

---

## 1. Problem Statement

### The Problem

Knowledge bases and search indexes are currently scoped to a single project (`tenantId` + `projectId`). This means:

1. **No reuse across projects.** If two projects within the same tenant need access to the same Jira knowledge base, the admin must create two separate KBs, configure two separate connectors, and run two separate sync pipelines — doubling storage, compute, and maintenance cost.

2. **No centralized knowledge management.** A tenant admin cannot create a shared knowledge base (e.g., company-wide HR policies, product documentation) and make it available to multiple projects. Each project team must independently set up their own.

3. **Inconsistent search results.** When the same data source is ingested separately into different project KBs, differences in sync timing, chunk strategies, or schema mappings lead to inconsistent search results across projects.

### The Gap

| Capability             | Current State                             | Desired State                           |
| ---------------------- | ----------------------------------------- | --------------------------------------- |
| KB scope               | Project-only                              | Project or tenant                       |
| Cross-project reuse    | Not possible — duplicate KB per project   | Tenant KB assigned to multiple projects |
| Centralized management | None — each project manages independently | Workspace admins manage tenant KBs      |
| Domain vocabulary      | Tied to KB                                | Project-specific overlay on shared KB   |
| Promotion workflow     | N/A                                       | Promote project KB to tenant-wide       |

### Impact

Without cross-project sharing:

- Enterprise customers with 10+ projects duplicate KBs and connectors, multiplying infrastructure cost
- Knowledge base updates must be applied independently per project
- No single source of truth for shared organizational knowledge

---

## 2. Current Architecture

### Schema Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Tenant                                                         │
│                                                                 │
│  ┌──────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │ Project A │    │ KnowledgeBase    │    │ SearchIndex      │  │
│  │           │───▶│ tenantId         │───▶│ tenantId         │  │
│  │           │    │ projectId ◀──────│    │ projectId        │  │
│  └──────────┘    │ searchIndexId    │    │ slug             │  │
│                   │ canonicalSchemaId│    │ embeddingModel   │  │
│  ┌──────────┐    └──────────────────┘    │ chunkStrategy    │  │
│  │ Project B │                            │ vectorStore      │  │
│  │           │    (cannot access          │ searchDefaults   │  │
│  │           │     Project A's KB)        └──────────────────┘  │
│  └──────────┘                                     │             │
│                                                    │             │
│                   ┌──────────────────┐    ┌────────▼─────────┐  │
│                   │ DomainVocabulary │    │ SearchSource     │  │
│                   │ projectKBId      │    │ indexId          │  │
│                   │ entries[]        │    │ sourceType       │  │
│                   └──────────────────┘    │ sourceConfig     │  │
│                                           └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Current Model Fields (relevant)

**KnowledgeBase**: `{ _id, tenantId, projectId, name, searchIndexId, canonicalSchemaId, status }`

**SearchIndex**: `{ _id, tenantId, projectId, slug, embeddingModel, chunkStrategy, vectorStore, searchDefaults }`

**DomainVocabulary**: `{ _id, tenantId, projectKnowledgeBaseId, version, entries[] }`

### Current Unique Constraints

- `KnowledgeBase`: `{ tenantId, projectId, name }` — unique
- `SearchIndex`: `{ tenantId, projectId, slug }` — unique

### Current API Structure

All KB routes are under `/api/search-ai/knowledge-bases/` at the tenant level. There are no project-scoped KB routes.

---

## 3. Design Goals

1. **Dual scope.** Knowledge bases can be either project-scoped (owned by one project) or tenant-scoped (shared across projects). The scope is explicit and immutable after creation (except via promotion).

2. **Explicit assignment.** Tenant-scoped KBs are not automatically visible to all projects. A workspace admin explicitly assigns them to specific projects. This prevents accidental data exposure and gives admins fine-grained control.

3. **Project-specific vocabulary.** Each project gets its own domain vocabulary overlay on a shared KB. Project A's business terminology doesn't affect Project B's search behavior, even when they share the same underlying index.

4. **Promotion path.** A project-scoped KB can be promoted to tenant scope when a team realizes their knowledge base has broader value. The promotion is atomic and preserves the original project's access.

5. **RBAC alignment.** Workspace-level permissions govern tenant KB management and assignment. Project-level permissions govern project KB management and vocabulary customization. No new permission infrastructure required — extend the existing model.

6. **No backward compatibility burden.** The platform is not yet in production. Existing data can be migrated with a one-time script. No API versioning or deprecation paths needed.

---

## 4. Solution: Dual-Scope Model

### Scope Types

```typescript
type KnowledgeBaseScope = 'project' | 'tenant';
```

**Project-scoped KB** (`scope: 'project'`):

- Owned by exactly one project (`projectId` is set)
- Only accessible within that project
- Managed by project admins/developers
- Has its own domain vocabulary
- Can be promoted to tenant scope

**Tenant-scoped KB** (`scope: 'tenant'`):

- Owned by the tenant (`projectId` is null)
- Accessible by projects that have an explicit assignment
- Managed by workspace admins
- Each assigned project can have its own domain vocabulary overlay
- Cannot be demoted back to project scope

### Architecture After Change

```
┌─────────────────────────────────────────────────────────────────────┐
│  Tenant                                                             │
│                                                                     │
│  ┌──────────────────────────────────┐                               │
│  │ Tenant-Scoped KB                 │                               │
│  │ scope: 'tenant'                  │                               │
│  │ projectId: null                  │                               │
│  │ searchIndexId ──────────────┐    │                               │
│  │ canonicalSchemaId           │    │                               │
│  └──────────────────────────────┘    │                               │
│           │                          │                               │
│           │  assignments             │                               │
│           │                          ▼                               │
│   ┌───────┴──────────┐      ┌──────────────────┐                   │
│   │ KB Assignment     │      │ SearchIndex      │                   │
│   │ knowledgeBaseId   │      │ scope: 'tenant'  │                   │
│   │ projectId: A      │      │ projectId: null  │                   │
│   ├──────────────────┤      └──────────────────┘                   │
│   │ KB Assignment     │              │                               │
│   │ knowledgeBaseId   │              │                               │
│   │ projectId: B      │      ┌───────┴────────┐                    │
│   └──────────────────┘      │ SearchSource    │                    │
│                              │ (shared)        │                    │
│   ┌──────────────────┐      └────────────────┘                    │
│   │ Project A         │                                             │
│   │                   │      ┌──────────────────┐                   │
│   │ DomainVocabulary ├─────▶│ Project A terms  │                   │
│   │ (overlay on       │      └──────────────────┘                   │
│   │  tenant KB)       │                                             │
│   └──────────────────┘                                             │
│                                                                     │
│   ┌──────────────────┐      ┌──────────────────┐                   │
│   │ Project B         │      │ Project-Scoped KB│                   │
│   │                   │      │ scope: 'project' │                   │
│   │ DomainVocabulary ├──┐   │ projectId: B     │                   │
│   │ (overlay on       │  │   └──────────────────┘                   │
│   │  tenant KB)       │  │                                          │
│   │                   │  │   ┌──────────────────┐                   │
│   │ DomainVocabulary ├──┴──▶│ Project B terms  │                   │
│   │ (for own KB)      │      │ (for project KB) │                   │
│   └──────────────────┘      └──────────────────┘                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. Data Model Changes

### KnowledgeBase — Modified

```typescript
interface IKnowledgeBase {
  _id: string; // UUID v7
  tenantId: string; // required — tenant isolation
  projectId: string | null; // CHANGED: null for tenant-scoped
  scope: 'project' | 'tenant'; // NEW: explicit scope discriminator
  name: string;
  description: string | null;
  searchIndexId: string | null; // auto-created SearchIndex
  canonicalSchemaId: string | null;
  connectorCount: number;
  status: 'creating' | 'ready' | 'rebuilding' | 'error';
  documentCount: number;
  lastIndexedAt: Date | null;
  indexError: string | null;
  isPublic: boolean;
  metadata: Record<string, unknown> | null;

  // Promotion provenance (set when promoted from project → tenant)
  promotedFrom: {
    // NEW: promotion tracking
    projectId: string;
    promotedAt: Date;
    promotedBy: string; // userId who triggered promotion
  } | null;

  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**Index changes:**

| Old Index                              | New Index                                     | Reason                                                                           |
| -------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| `{ tenantId, projectId, name }` unique | `{ tenantId, scope, projectId, name }` unique | Tenant-scoped KBs have `projectId: null`; project-scoped need project uniqueness |
| `{ tenantId, projectId }`              | `{ tenantId, scope }`                         | Query by scope type                                                              |
| —                                      | `{ tenantId, projectId }` sparse              | Query project-scoped KBs (sparse because `projectId` is null for tenant KBs)     |

### SearchIndex — Modified

```typescript
interface ISearchIndex {
  _id: string;
  tenantId: string;
  projectId: string | null; // CHANGED: null for tenant-scoped
  scope: 'project' | 'tenant'; // NEW: mirrors parent KB scope
  slug: string;
  name: string;
  description: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  chunkStrategy: ChunkStrategy;
  vectorStore: VectorStoreConfig;
  searchDefaults: SearchDefaults;
  status: 'creating' | 'ready' | 'rebuilding' | 'error';
  documentCount: number;
  chunkCount: number;
  sourceCount: number;
  lastIndexedAt: Date | null;
  indexError: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**Index changes:**

| Old Index                              | New Index                                     | Reason               |
| -------------------------------------- | --------------------------------------------- | -------------------- |
| `{ tenantId, projectId, slug }` unique | `{ tenantId, scope, projectId, slug }` unique | Same rationale as KB |

### KnowledgeBaseAssignment — New Collection

```typescript
interface IKnowledgeBaseAssignment {
  _id: string; // UUID v7
  tenantId: string; // tenant isolation
  knowledgeBaseId: string; // ref → KnowledgeBase (must be tenant-scoped)
  projectId: string; // ref → Project being granted access
  assignedBy: string; // userId who created the assignment
  assignedAt: Date; // when the assignment was created
  searchDefaults: {
    // project-level overrides (optional)
    topK?: number;
    similarityThreshold?: number;
    reranker?: {
      provider: string;
      model?: string;
      topN?: number;
    };
  } | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes:**

| Index                                      | Type     | Purpose                            |
| ------------------------------------------ | -------- | ---------------------------------- |
| `{ tenantId, knowledgeBaseId, projectId }` | unique   | Prevent duplicate assignments      |
| `{ tenantId, projectId }`                  | compound | List all KBs assigned to a project |
| `{ tenantId, knowledgeBaseId }`            | compound | List all projects assigned to a KB |

### DomainVocabulary — Modified

```typescript
interface IDomainVocabulary {
  _id: string;
  tenantId: string;
  knowledgeBaseId: string; // CHANGED: renamed from projectKnowledgeBaseId
  projectId: string; // NEW: which project's vocabulary this is
  version: number;
  status: 'draft' | 'active' | 'archived';
  entries: IVocabularyEntry[];
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**Key change**: A vocabulary is now keyed by `(knowledgeBaseId, projectId)` rather than just `projectKnowledgeBaseId`. This allows each project to have its own vocabulary for a shared tenant-scoped KB.

**Index changes:**

| Old Index                                    | New Index                                        | Reason                         |
| -------------------------------------------- | ------------------------------------------------ | ------------------------------ |
| `{ projectKnowledgeBaseId, version }` unique | `{ knowledgeBaseId, projectId, version }` unique | Per-project vocabulary per KB  |
| `{ tenantId }`                               | `{ tenantId, projectId }`                        | Query by project               |
| —                                            | `{ tenantId, knowledgeBaseId }`                  | List all vocabularies for a KB |

### CanonicalSchema — Unchanged

Canonical schemas remain tied to the knowledge base (`knowledgeBaseId`). Since the KB itself carries the scope, no schema changes are needed. A tenant-scoped KB has one canonical schema shared across all assigned projects.

### SearchSource, SearchDocument, SearchChunk — Unchanged

These remain tied to `indexId`. Since the SearchIndex carries the scope, downstream collections need no structural changes. Tenant isolation is enforced via `tenantId` on each model.

---

## 6. Knowledge Base Assignment

### Assignment Rules

1. Only tenant-scoped KBs (`scope: 'tenant'`) can be assigned to projects.
2. Project-scoped KBs are implicitly assigned to their owning project — no assignment record needed.
3. An assignment grants read + search access. Write access to the KB's data (connectors, schema, documents) remains with workspace admins.
4. Assignments are explicit — a tenant-scoped KB is not visible to any project until assigned.
5. Removing an assignment does not delete the KB or its data. It only removes the project's access.

### Assignment Lifecycle

```
Workspace Admin creates tenant KB
        │
        ▼
Workspace Admin assigns KB to Project A
        │
        ▼
KnowledgeBaseAssignment { kbId, projectId: A } created
        │
        ▼
Project A can now: search, create vocabulary overlay, read schema
Project A cannot: add/remove connectors, modify schema, delete KB
        │
        ▼
Workspace Admin assigns KB to Project B
        │
        ▼
KnowledgeBaseAssignment { kbId, projectId: B } created
        │
        ▼
Both projects search the same index, each with their own vocabulary
```

### Assignment with Search Default Overrides

Each assignment can optionally override the index's search defaults:

```typescript
// Base search defaults on the SearchIndex
searchDefaults: {
  topK: 10,
  similarityThreshold: 0.7,
  includeMetadata: true,
  includeContent: true,
}

// Project A's assignment overrides
assignment.searchDefaults: {
  topK: 5,                    // Project A wants fewer results
  similarityThreshold: 0.85,  // Higher precision threshold
}

// Effective defaults for Project A: merge base + override
effectiveDefaults = { ...index.searchDefaults, ...assignment.searchDefaults }
```

---

## 7. Domain Vocabulary Scoping

### Why Per-Project Vocabulary?

Domain vocabulary (Layer 3 in the three-layer search schema) maps business terminology to canonical fields. Different projects may use different terminology for the same data:

- **Project A** (Customer Support): "ticket" → `{ field: 'issueType', filter: 'support' }`
- **Project B** (Engineering): "ticket" → `{ field: 'issueType', filter: 'bug' }`

Even when both projects share the same Jira knowledge base, their vocabulary must differ.

### Resolution Chain

When a search query includes domain terms, resolution follows this chain:

```
User query: "show me open tickets"
        │
        ▼
1. Resolve vocabulary for (knowledgeBaseId, projectId)
   → Find matching terms: "ticket" → { field: 'issueType', filter: 'support' }
        │
        ▼
2. Apply canonical field mappings from CanonicalSchema
   → Map 'issueType' to the actual indexed field name
        │
        ▼
3. Execute structured query with resolved filters
```

### Vocabulary CRUD

| Operation                               | Scope   | Permission                                                |
| --------------------------------------- | ------- | --------------------------------------------------------- |
| Create vocabulary for project KB        | Project | `vocabulary:create` (project role)                        |
| Create vocabulary overlay for tenant KB | Project | `vocabulary:create` (project role) + KB assignment exists |
| Edit vocabulary entries                 | Project | `vocabulary:update` (project role)                        |
| Delete vocabulary                       | Project | `vocabulary:delete` (project role)                        |
| Suggest terms (LLM)                     | Project | `vocabulary:update` (project role)                        |
| Bulk update terms                       | Project | `vocabulary:update` (project role)                        |

---

## 8. KB Promotion: Project to Tenant

### When to Promote

A project team builds a KB that turns out to be useful across the organization. Rather than recreating it as a tenant-scoped KB and re-ingesting all data, the admin promotes the existing KB.

### Promotion Operation

The promotion is a single atomic operation:

```
Before:
  KB { scope: 'project', projectId: 'proj-A', name: 'Jira KB' }
  SearchIndex { scope: 'project', projectId: 'proj-A' }
  DomainVocabulary { knowledgeBaseId: kbId, projectId: 'proj-A' }

Promote(kbId, promotedBy: userId)
        │
        ▼
After:
  KB { scope: 'tenant', projectId: null, name: 'Jira KB',
       promotedFrom: { projectId: 'proj-A', promotedAt: now, promotedBy: userId } }
  SearchIndex { scope: 'tenant', projectId: null }
  KnowledgeBaseAssignment { kbId, projectId: 'proj-A', assignedBy: userId }
  DomainVocabulary { knowledgeBaseId: kbId, projectId: 'proj-A' }  // unchanged
```

### Promotion Steps (in a single transaction)

1. Verify the KB exists and `scope === 'project'`
2. Verify the caller has `workspace:knowledge_bases:manage` permission
3. Update `KnowledgeBase`: set `scope = 'tenant'`, `projectId = null`, `promotedFrom = { ... }`
4. Update `SearchIndex`: set `scope = 'tenant'`, `projectId = null`
5. Create `KnowledgeBaseAssignment`: assign the KB back to the original project
6. Vocabulary remains unchanged — it's already keyed by `(knowledgeBaseId, projectId)`
7. Update unique index entries (name uniqueness now at tenant level)

### Promotion Constraints

- **Irreversible**: No demote operation. Once promoted, a KB stays at tenant scope.
- **Name collision check**: If a tenant-scoped KB with the same name already exists, the promotion fails with a conflict error. The admin must rename before promoting.
- **RBAC**: Only users with `workspace:knowledge_bases:manage` can promote. Project admins cannot promote without workspace-level permission.

### Promotion Provenance

The `promotedFrom` field on the KB provides audit trail:

```typescript
{
  projectId: string; // original owning project
  promotedAt: Date; // when promotion happened
  promotedBy: string; // userId who triggered it
}
```

This is informational only — it doesn't affect access control or query behavior.

---

## 9. RBAC Permission Model

### New Permissions

| Permission               | Description                           | Level                |
| ------------------------ | ------------------------------------- | -------------------- |
| `knowledge_base:create`  | Create a new KB                       | Workspace or Project |
| `knowledge_base:read`    | View KB details, schema, sources      | Workspace or Project |
| `knowledge_base:update`  | Edit KB settings, schema, connectors  | Workspace or Project |
| `knowledge_base:delete`  | Delete a KB                           | Workspace or Project |
| `knowledge_base:assign`  | Assign/unassign tenant KB to projects | Workspace only       |
| `knowledge_base:promote` | Promote project KB to tenant scope    | Workspace only       |
| `knowledge_base:search`  | Execute search queries against a KB   | Project              |
| `vocabulary:create`      | Create domain vocabulary              | Project              |
| `vocabulary:read`        | View vocabulary entries               | Project              |
| `vocabulary:update`      | Edit vocabulary entries, bulk update  | Project              |
| `vocabulary:delete`      | Delete vocabulary                     | Project              |

### Workspace Role Permissions

| Permission                       | OWNER | ADMIN | OPERATOR | MEMBER | VIEWER |
| -------------------------------- | ----- | ----- | -------- | ------ | ------ |
| `knowledge_base:create` (tenant) | yes   | yes   | **no**   | **no** | **no** |
| `knowledge_base:read` (tenant)   | yes   | yes   | yes      | yes    | yes    |
| `knowledge_base:update` (tenant) | yes   | yes   | **no**   | **no** | **no** |
| `knowledge_base:delete` (tenant) | yes   | yes   | **no**   | **no** | **no** |
| `knowledge_base:assign`          | yes   | yes   | **no**   | **no** | **no** |
| `knowledge_base:promote`         | yes   | yes   | **no**   | **no** | **no** |

### Project Role Permissions

| Permission                        | admin | developer | viewer |
| --------------------------------- | ----- | --------- | ------ |
| `knowledge_base:create` (project) | yes   | yes       | **no** |
| `knowledge_base:read`             | yes   | yes       | yes    |
| `knowledge_base:update` (project) | yes   | yes       | **no** |
| `knowledge_base:delete` (project) | yes   | **no**    | **no** |
| `knowledge_base:search`           | yes   | yes       | yes    |
| `vocabulary:create`               | yes   | yes       | **no** |
| `vocabulary:read`                 | yes   | yes       | yes    |
| `vocabulary:update`               | yes   | yes       | **no** |
| `vocabulary:delete`               | yes   | **no**    | **no** |

### Permission Check Flow

```
Request: GET /api/projects/:projectId/knowledge-bases

1. Authenticate (unified auth middleware → tenantContext)
2. Resolve project membership (requireProjectPermission)
3. Check permission: 'knowledge_base:read'
4. Query:
   a. Project-scoped KBs: find({ tenantId, projectId, scope: 'project' })
   b. Assigned tenant KBs: find assignments({ tenantId, projectId })
      → populate KB details
5. Return merged list with scope indicator
```

```
Request: POST /api/workspace/knowledge-bases (tenant-scoped creation)

1. Authenticate (unified auth middleware → tenantContext)
2. Check workspace permission: 'knowledge_base:create'
3. Create KB with scope: 'tenant', projectId: null
4. Return created KB
```

```
Request: POST /api/workspace/knowledge-bases/:kbId/assign (assign to project)

1. Authenticate
2. Check workspace permission: 'knowledge_base:assign'
3. Verify KB exists and scope === 'tenant'
4. Verify target project exists and belongs to tenant
5. Create KnowledgeBaseAssignment
6. Return assignment
```

---

## 10. API Route Design

### Workspace-Level Routes (Tenant KB Management)

All under `/api/workspace/knowledge-bases/`. Require workspace-level permissions.

| Method   | Route                                                    | Permission               | Description                                |
| -------- | -------------------------------------------------------- | ------------------------ | ------------------------------------------ |
| `POST`   | `/api/workspace/knowledge-bases`                         | `knowledge_base:create`  | Create tenant-scoped KB                    |
| `GET`    | `/api/workspace/knowledge-bases`                         | `knowledge_base:read`    | List all tenant-scoped KBs                 |
| `GET`    | `/api/workspace/knowledge-bases/:kbId`                   | `knowledge_base:read`    | Get tenant KB details                      |
| `PUT`    | `/api/workspace/knowledge-bases/:kbId`                   | `knowledge_base:update`  | Update tenant KB settings                  |
| `DELETE` | `/api/workspace/knowledge-bases/:kbId`                   | `knowledge_base:delete`  | Delete tenant KB (cascades to assignments) |
| `POST`   | `/api/workspace/knowledge-bases/:kbId/assign`            | `knowledge_base:assign`  | Assign KB to a project                     |
| `DELETE` | `/api/workspace/knowledge-bases/:kbId/assign/:projectId` | `knowledge_base:assign`  | Remove KB assignment from project          |
| `GET`    | `/api/workspace/knowledge-bases/:kbId/assignments`       | `knowledge_base:read`    | List all project assignments for a KB      |
| `POST`   | `/api/workspace/knowledge-bases/:kbId/promote`           | `knowledge_base:promote` | Promote project KB to tenant scope         |

### Project-Level Routes (Project KB + Vocabulary)

All under `/api/projects/:projectId/knowledge-bases/`. Require project-level permissions via `requireProjectPermission`.

| Method   | Route                                            | Permission              | Description                                    |
| -------- | ------------------------------------------------ | ----------------------- | ---------------------------------------------- |
| `POST`   | `/api/projects/:projectId/knowledge-bases`       | `knowledge_base:create` | Create project-scoped KB                       |
| `GET`    | `/api/projects/:projectId/knowledge-bases`       | `knowledge_base:read`   | List project's KBs (own + assigned tenant KBs) |
| `GET`    | `/api/projects/:projectId/knowledge-bases/:kbId` | `knowledge_base:read`   | Get KB details (verify access)                 |
| `PUT`    | `/api/projects/:projectId/knowledge-bases/:kbId` | `knowledge_base:update` | Update project-scoped KB only                  |
| `DELETE` | `/api/projects/:projectId/knowledge-bases/:kbId` | `knowledge_base:delete` | Delete project-scoped KB only                  |

### Project-Level Vocabulary Routes

| Method   | Route                                                                | Permission          | Description                       |
| -------- | -------------------------------------------------------------------- | ------------------- | --------------------------------- |
| `GET`    | `/api/projects/:projectId/knowledge-bases/:kbId/vocabulary`          | `vocabulary:read`   | Get project's vocabulary for a KB |
| `POST`   | `/api/projects/:projectId/knowledge-bases/:kbId/vocabulary`          | `vocabulary:create` | Create vocabulary for KB          |
| `PUT`    | `/api/projects/:projectId/knowledge-bases/:kbId/vocabulary/:vocabId` | `vocabulary:update` | Update vocabulary entries         |
| `DELETE` | `/api/projects/:projectId/knowledge-bases/:kbId/vocabulary/:vocabId` | `vocabulary:delete` | Delete vocabulary                 |
| `POST`   | `/api/projects/:projectId/knowledge-bases/:kbId/vocabulary/suggest`  | `vocabulary:update` | LLM-suggested terms               |
| `POST`   | `/api/projects/:projectId/knowledge-bases/:kbId/vocabulary/bulk`     | `vocabulary:update` | Bulk update terms                 |

### Search Runtime Routes (Unchanged)

The search-ai-runtime routes remain the same:

```
POST /api/search/:indexId/query
POST /api/search/:indexId/structured
POST /api/search/:indexId/aggregate
POST /api/search/:indexId/suggest
POST /api/search/:indexId/similar
POST /api/search/:indexId/resolve
```

The `verifyIndexOwnership` middleware is updated to check:

1. If index is project-scoped: verify `projectId` matches the caller's project context
2. If index is tenant-scoped: verify the caller's project has an active assignment

---

## 11. Query Patterns & Authorization

### List KBs for a Project

Returns the union of project-scoped KBs and assigned tenant KBs.

```typescript
async function listKnowledgeBasesForProject(
  tenantId: string,
  projectId: string,
): Promise<KnowledgeBaseWithScope[]> {
  // 1. Project-scoped KBs owned by this project
  const projectKBs = await KnowledgeBase.find({
    tenantId,
    projectId,
    scope: 'project',
  });

  // 2. Tenant-scoped KBs assigned to this project
  const assignments = await KnowledgeBaseAssignment.find({
    tenantId,
    projectId,
  });
  const assignedKBIds = assignments.map((a) => a.knowledgeBaseId);
  const tenantKBs =
    assignedKBIds.length > 0
      ? await KnowledgeBase.find({
          tenantId,
          _id: { $in: assignedKBIds },
          scope: 'tenant',
        })
      : [];

  // 3. Merge with scope indicator
  return [
    ...projectKBs.map((kb) => ({ ...kb.toObject(), accessType: 'owned' as const })),
    ...tenantKBs.map((kb) => ({ ...kb.toObject(), accessType: 'assigned' as const })),
  ];
}
```

### Verify KB Access for a Project

Used by all project-level KB routes to verify the caller can access a specific KB.

```typescript
async function verifyKBAccess(
  tenantId: string,
  projectId: string,
  kbId: string,
): Promise<{ kb: IKnowledgeBase; accessType: 'owned' | 'assigned' } | null> {
  // Try project-scoped first
  const projectKB = await KnowledgeBase.findOne({
    _id: kbId,
    tenantId,
    projectId,
    scope: 'project',
  });
  if (projectKB) return { kb: projectKB, accessType: 'owned' };

  // Try tenant-scoped with assignment
  const tenantKB = await KnowledgeBase.findOne({
    _id: kbId,
    tenantId,
    scope: 'tenant',
  });
  if (!tenantKB) return null;

  const assignment = await KnowledgeBaseAssignment.findOne({
    tenantId,
    knowledgeBaseId: kbId,
    projectId,
  });
  if (!assignment) return null;

  return { kb: tenantKB, accessType: 'assigned' };
}
```

### Verify Index Ownership (Search Runtime)

Updated `verifyIndexOwnership` middleware:

```typescript
async function verifyIndexOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { indexId } = req.params;
  const { tenantId } = req.tenantContext!;

  const index = await SearchIndex.findOne({ _id: indexId, tenantId });
  if (!index) {
    res.status(404).json({ error: 'Index not found' });
    return;
  }

  if (index.scope === 'project') {
    // Project-scoped: caller must be in the owning project
    if (req.tenantContext!.projectId !== index.projectId) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }
  } else {
    // Tenant-scoped: caller's project must have an assignment
    const projectId = req.tenantContext!.projectId;
    if (projectId) {
      const assignment = await KnowledgeBaseAssignment.findOne({
        tenantId,
        knowledgeBaseId: index.knowledgeBaseId,
        projectId,
      });
      if (!assignment) {
        res.status(404).json({ error: 'Index not found' });
        return;
      }
    }
    // If no projectId (workspace-level API key), allow access to tenant indexes
  }

  req.searchIndex = index;
  next();
}
```

### Vocabulary Resolution with Project Context

Updated vocabulary resolution to include project context:

```typescript
async function resolveVocabulary(
  tenantId: string,
  knowledgeBaseId: string,
  projectId: string,
): Promise<IVocabularyEntry[]> {
  const vocab = await DomainVocabulary.findOne({
    tenantId,
    knowledgeBaseId,
    projectId,
    status: 'active',
  }).sort({ version: -1 });

  return vocab?.entries ?? [];
}
```

---

## 12. Admin UX

### Workspace Settings: Knowledge Bases Tab

```
┌─────────────────────────────────────────────────────────────┐
│  Workspace Settings > Knowledge Bases                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [+ Create Knowledge Base]                                  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ HR Policies KB                      Tenant-scoped   │   │
│  │ 3 connectors · 1,247 documents · Ready              │   │
│  │ Assigned to: Project A, Project B, Project C         │   │
│  │                                    [Manage] [Delete] │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Product Docs KB                     Tenant-scoped   │   │
│  │ 1 connector · 523 documents · Ready                  │   │
│  │ Assigned to: Project A                               │   │
│  │                                    [Manage] [Delete] │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ── Project-Scoped (visible for promotion) ──               │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Jira Sprint KB                      Project B       │   │
│  │ 1 connector · 89 documents · Ready                   │   │
│  │                                  [Promote] [Details] │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### KB Assignment Dialog

Opened when clicking "Manage" on a tenant-scoped KB:

```
┌─────────────────────────────────────────────────────┐
│  Manage Assignments: HR Policies KB                 │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Assign this knowledge base to projects:            │
│                                                     │
│  ☑ Project A (Customer Support)    [Configure]      │
│  ☑ Project B (Engineering)         [Configure]      │
│  ☑ Project C (Sales)               [Configure]      │
│  ☐ Project D (Marketing)                            │
│  ☐ Project E (Internal Tools)                       │
│                                                     │
│  [Configure] opens search default overrides:        │
│  ┌─────────────────────────────────────────────┐    │
│  │ Search Defaults Override (Project A)        │    │
│  │ Top K results: [5     ]                     │    │
│  │ Similarity threshold: [0.85  ]              │    │
│  │ Reranker: [None ▾]                          │    │
│  │                          [Save] [Cancel]    │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│                        [Save Assignments] [Cancel]  │
└─────────────────────────────────────────────────────┘
```

### Promotion Confirmation Dialog

```
┌─────────────────────────────────────────────────────┐
│  Promote to Workspace                               │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Promote "Jira Sprint KB" from Project B to         │
│  workspace-wide availability?                       │
│                                                     │
│  What happens:                                      │
│  · KB becomes tenant-scoped (managed by workspace   │
│    admins)                                          │
│  · Project B retains access automatically           │
│  · Other projects can be assigned access            │
│  · Project B's vocabulary is preserved              │
│  · This action cannot be undone                     │
│                                                     │
│                          [Promote] [Cancel]         │
└─────────────────────────────────────────────────────┘
```

### Project Settings: Knowledge Bases Tab

```
┌─────────────────────────────────────────────────────────────┐
│  Project A Settings > Knowledge Bases                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [+ Create Knowledge Base]                                  │
│                                                             │
│  ── Project Knowledge Bases ──                              │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Internal FAQ KB                     Project-scoped  │   │
│  │ 2 connectors · 312 documents · Ready                │   │
│  │ Vocabulary: 45 terms                                │   │
│  │                        [Manage] [Vocabulary] [Delete]│   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ── Shared Knowledge Bases (assigned by workspace admin) ── │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ HR Policies KB                      Tenant-scoped   │   │
│  │ 3 connectors · 1,247 documents · Ready              │   │
│  │ Vocabulary: 12 terms (project overlay)              │   │
│  │                               [Details] [Vocabulary] │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Product Docs KB                     Tenant-scoped   │   │
│  │ 1 connector · 523 documents · Ready                  │   │
│  │ Vocabulary: Not configured                          │   │
│  │                               [Details] [Vocabulary] │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Key UX differences by scope:**

- Project-scoped KBs show full management actions (Manage, Delete)
- Tenant-scoped KBs show read-only details + vocabulary management only
- Clear visual separation between "owned" and "shared" sections
- Tenant-scoped KBs display "(assigned by workspace admin)" label

---

## 13. Migration Strategy

Since the platform is not in production, migration is straightforward:

### Migration Script

```typescript
async function migrateToScopedKnowledgeBases(): Promise<void> {
  // 1. Add scope field to all existing KBs (all are project-scoped)
  await KnowledgeBase.updateMany(
    { scope: { $exists: false } },
    { $set: { scope: 'project', promotedFrom: null } },
  );

  // 2. Add scope field to all existing SearchIndexes
  await SearchIndex.updateMany({ scope: { $exists: false } }, { $set: { scope: 'project' } });

  // 3. Rename DomainVocabulary.projectKnowledgeBaseId → knowledgeBaseId
  // and add projectId field from the referenced KB
  const vocabs = await DomainVocabulary.find({});
  for (const vocab of vocabs) {
    const kb = await KnowledgeBase.findById(vocab.projectKnowledgeBaseId);
    if (kb) {
      await DomainVocabulary.updateOne(
        { _id: vocab._id },
        {
          $set: { knowledgeBaseId: vocab.projectKnowledgeBaseId, projectId: kb.projectId },
          $unset: { projectKnowledgeBaseId: 1 },
        },
      );
    }
  }

  // 4. Drop old indexes and create new ones
  // (handled by model index definitions on next server start)
}
```

### Index Recreation

Old unique indexes will be dropped and new ones created automatically by Mongoose on server startup, since the index definitions change in the model files.

---

## 14. Testing Strategy

### Unit Tests

**KB Access Verification:**

- Project-scoped KB: accessible by owning project, 404 for other projects
- Tenant-scoped KB with assignment: accessible by assigned project
- Tenant-scoped KB without assignment: 404 for unassigned project
- Cross-tenant access: always 404

**Assignment CRUD:**

- Create assignment for tenant-scoped KB: success
- Create assignment for project-scoped KB: reject with error
- Duplicate assignment: reject with conflict
- Delete assignment: success, project loses access
- List assignments: returns only for specified KB/project

**Promotion:**

- Promote project KB: scope flips, assignment created, vocabulary preserved
- Promote already-tenant KB: reject with error
- Name collision during promotion: reject with conflict
- Promotion RBAC: only workspace admin can promote

### Authorization Tests (per CLAUDE.md pattern)

Every route handler that accepts an ID parameter must have:

1. **Correct permission required**: Request with the wrong role is rejected with 403
2. **Cross-tenant access returns 404**: Request for another tenant's resource returns 404
3. **Cross-project access returns 404**: Request for a KB in another project (without assignment) returns 404
4. **Missing auth returns 401**: Request without authentication is rejected

```typescript
describe('GET /api/projects/:projectId/knowledge-bases/:kbId', () => {
  it('should return KB for project admin', async () => {
    /* ... */
  });
  it('should return KB for developer with read permission', async () => {
    /* ... */
  });
  it('should return assigned tenant KB', async () => {
    /* ... */
  });
  it('should return 404 for unassigned tenant KB', async () => {
    /* ... */
  });
  it('should return 404 for cross-tenant KB', async () => {
    /* ... */
  });
  it('should return 404 for cross-project KB', async () => {
    /* ... */
  });
  it('should return 401 without auth', async () => {
    /* ... */
  });
});

describe('POST /api/workspace/knowledge-bases/:kbId/assign', () => {
  it('should assign KB to project for workspace admin', async () => {
    /* ... */
  });
  it('should reject assignment for project-scoped KB', async () => {
    /* ... */
  });
  it('should reject duplicate assignment', async () => {
    /* ... */
  });
  it('should reject for non-admin workspace role', async () => {
    /* ... */
  });
  it('should return 404 for cross-tenant KB', async () => {
    /* ... */
  });
  it('should return 401 without auth', async () => {
    /* ... */
  });
});

describe('POST /api/workspace/knowledge-bases/:kbId/promote', () => {
  it('should promote project KB to tenant scope', async () => {
    /* ... */
  });
  it('should auto-assign KB to original project after promotion', async () => {
    /* ... */
  });
  it('should preserve vocabulary after promotion', async () => {
    /* ... */
  });
  it('should reject promotion of already-tenant KB', async () => {
    /* ... */
  });
  it('should reject on name collision', async () => {
    /* ... */
  });
  it('should reject for non-admin workspace role', async () => {
    /* ... */
  });
});
```

### Integration Tests

**Search with shared KB:**

1. Create tenant KB, assign to two projects
2. Each project creates its own vocabulary
3. Same search query returns different results per project (due to vocabulary)

**Promotion flow:**

1. Create project KB with connectors, documents, vocabulary
2. Promote to tenant scope
3. Verify original project retains access
4. Assign to second project
5. Verify both projects can search

---

## 15. Design Decisions

### D1: Why explicit assignment instead of auto-visible?

Making tenant KBs automatically visible to all projects would be simpler, but violates the principle of least privilege. A tenant with 50 projects shouldn't expose every KB to every project by default. Explicit assignment:

- Prevents accidental data exposure (HR data visible to external-facing projects)
- Gives workspace admins fine-grained control
- Creates an auditable record of who assigned what and when
- Aligns with the existing project-scoped RBAC model

### D2: Why no demote (tenant → project)?

Demotion creates complications:

- What happens to other projects' assignments? Silently removed?
- What happens to other projects' vocabulary overlays? Orphaned?
- What happens to search results in progress? Broken mid-query?

Promotion is a one-way escalation of trust. If a KB should be project-scoped, create a new one. The original tenant KB can be deleted if no longer needed.

### D3: Why per-project vocabulary instead of shared vocabulary with project overrides?

A "base vocabulary + override" pattern adds merge complexity:

- Conflict resolution when a project term shadows a shared term
- Ordering ambiguity (which vocabulary wins?)
- Harder to reason about for project teams

Per-project vocabulary is simpler: each project has its own vocabulary for a given KB. No merging, no conflicts, no ordering. If a project wants to start with the same terms as another project, they can copy the vocabulary.

### D4: Why `scope` field instead of `projectId: null` as the discriminator?

Using `projectId: null` as an implicit scope indicator is fragile:

- Easy to forget to check in queries
- No type-level enforcement (TypeScript can't narrow on `null`)
- Harder to read in query logs and admin UIs

An explicit `scope: 'project' | 'tenant'` field:

- Self-documenting at the query level
- Enables type narrowing in TypeScript
- Works as an index prefix for efficient queries
- Clear in admin UIs and audit logs

### D5: Why search default overrides on the assignment, not a separate config?

Assignment-level overrides keep related configuration together:

- The assignment already represents "this project's relationship to this KB"
- No need for a separate collection just for search preferences
- Simple merge at query time: `{ ...index.searchDefaults, ...assignment.searchDefaults }`
- Easy to reset (set overrides to null)

---

## 16. Files Changed

| File                                                                                      | Change                                                               | Status   |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------- |
| `packages/database/src/models/knowledge-base.model.ts`                                    | Add `scope`, `promotedFrom` fields; update indexes                   | Modified |
| `packages/database/src/models/search-index.model.ts`                                      | Add `scope` field; update indexes                                    | Modified |
| `packages/database/src/models/domain-vocabulary.model.ts`                                 | Rename `projectKnowledgeBaseId` → `knowledgeBaseId`; add `projectId` | Modified |
| `packages/database/src/models/knowledge-base-assignment.model.ts`                         | New model for KB ↔ project assignments                               | New      |
| `packages/database/src/models/index.ts`                                                   | Export new model                                                     | Modified |
| `packages/shared/src/rbac/permission-resolver.ts`                                         | Add KB + vocabulary permissions to role definitions                  | Modified |
| `apps/studio/src/app/api/workspace/knowledge-bases/route.ts`                              | Workspace-level KB CRUD                                              | New      |
| `apps/studio/src/app/api/workspace/knowledge-bases/[kbId]/route.ts`                       | Single tenant KB operations                                          | New      |
| `apps/studio/src/app/api/workspace/knowledge-bases/[kbId]/assign/route.ts`                | Assignment management                                                | New      |
| `apps/studio/src/app/api/workspace/knowledge-bases/[kbId]/promote/route.ts`               | Promotion endpoint                                                   | New      |
| `apps/studio/src/app/api/projects/[projectId]/knowledge-bases/route.ts`                   | Project-level KB list + create                                       | New      |
| `apps/studio/src/app/api/projects/[projectId]/knowledge-bases/[kbId]/route.ts`            | Project-level KB detail                                              | New      |
| `apps/studio/src/app/api/projects/[projectId]/knowledge-bases/[kbId]/vocabulary/route.ts` | Vocabulary CRUD                                                      | New      |
| `apps/search-ai-runtime/src/middleware/verify-index-ownership.ts`                         | Update ownership check for dual scope                                | Modified |
| `apps/search-ai-runtime/src/routes/search.ts`                                             | Pass project context to vocabulary resolution                        | Modified |
| `apps/studio/src/components/workspace/KnowledgeBasesTab.tsx`                              | Workspace KB management UI                                           | New      |
| `apps/studio/src/components/workspace/KBAssignmentDialog.tsx`                             | Assignment management dialog                                         | New      |
| `apps/studio/src/components/workspace/KBPromoteDialog.tsx`                                | Promotion confirmation dialog                                        | New      |
| `apps/studio/src/components/project/ProjectKnowledgeBasesTab.tsx`                         | Project KB list (owned + shared)                                     | New      |
| `packages/database/src/migrations/add-kb-scope.ts`                                        | Migration script                                                     | New      |
| `apps/studio/src/__tests__/kb-access.test.ts`                                             | KB access verification tests                                         | New      |
| `apps/studio/src/__tests__/kb-assignment.test.ts`                                         | Assignment CRUD tests                                                | New      |
| `apps/studio/src/__tests__/kb-promotion.test.ts`                                          | Promotion flow tests                                                 | New      |
| `apps/search-ai-runtime/src/__tests__/index-ownership-authz.test.ts`                      | Updated ownership authz tests                                        | Modified |

---

## Implementation Status

| Phase   | Description                                                                       | Status  |
| ------- | --------------------------------------------------------------------------------- | ------- |
| Phase 1 | Data model changes (scope field, assignment collection, vocabulary refactor)      | Pending |
| Phase 2 | Workspace API routes (tenant KB CRUD, assignment, promotion)                      | Pending |
| Phase 3 | Project API routes (project KB list, vocabulary management)                       | Pending |
| Phase 4 | Search runtime updates (ownership verification, vocabulary resolution)            | Pending |
| Phase 5 | Studio UI (workspace KB tab, assignment dialog, promotion dialog, project KB tab) | Pending |
| Phase 6 | Migration script and testing                                                      | Pending |

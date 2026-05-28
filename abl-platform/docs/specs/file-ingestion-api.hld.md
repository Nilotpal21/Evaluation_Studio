# File Ingestion API — High-Level Design

## What

A unified, public-facing file ingestion API that allows authenticated users to upload documents (PDF, DOCX, images, CSV, JSON) or submit JSON data directly for indexing — with optional document-level permissions (ACL) and a status-tracking endpoint. This complements the existing `/query` endpoint by providing the "write" side of the search pipeline.

## Problem Statement

Currently, file uploads go through an internal route (`POST /api/indexes/:indexId/sources/:sourceId/documents`) that requires knowledge of internal concepts (indexId, sourceId). There's no way to:

1. Set document-level permissions (ACL) during upload — only connector crawlers populate `acl_document_permissions`
2. Submit JSON data directly (must upload as a `.json` file)
3. Track processing status through a simple, unified endpoint

## Architecture Approach

### Packages Changed

| Package                       | Change                                                      |
| ----------------------------- | ----------------------------------------------------------- |
| `apps/search-ai`              | New ingestion route, permission-on-upload service           |
| `packages/search-ai-internal` | Extend `MongoPermissionStore` for manual permission setting |
| `packages/search-ai-sdk`      | Export new types/constants for ingestion API                |

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Client / SDK                                   │
│  POST /api/ingest/:indexId/documents                                 │
│  (multipart file OR JSON body)                                       │
│  + optional permissions payload                                      │
└────────────────┬────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Auth Middleware (JWT or API Key)                                     │
│  → tenantId, userId, permissions['document:write']                   │
└────────────────┬────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Ingestion Route Handler                                             │
│  1. Validate file/JSON + metadata                                    │
│  2. Auto-resolve source (create "api-upload" source if needed)       │
│  3. Store file → S3/local                                            │
│  4. Create SearchDocument (status: PENDING)                          │
│  5. Set document permissions in acl_document_permissions (if given)  │
│  6. Route to extraction pipeline (Docling/Legacy/JSON/Structured)    │
│  7. Return { documentId, status, statusUrl }                         │
└────────────────┬────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Existing Pipeline (unchanged)                                       │
│  Extraction → Page Processing → Chunking → Embedding → OpenSearch   │
│  (status updates: EXTRACTING → EXTRACTED → ENRICHING → INDEXED)     │
└─────────────────────────────────────────────────────────────────────┘

Status Check:
  GET /api/ingest/:indexId/documents/:documentId/status
  → { status, progress, pageCount, chunkCount, error?, completedAt? }
```

### Key Integration Points

1. **Auth**: Reuses existing `authMiddleware` (JWT + API Key). Requires `document:write` permission.
2. **Storage**: Reuses `createFileStorage()` from `storage-factory.ts` (S3/local).
3. **Pipeline**: Reuses existing `routeDocument()` for MIME routing → BullMQ queues.
4. **Permissions**: Extends `MongoPermissionStore.upsertDocument()` to support manual source.
5. **Status**: Reads `SearchDocument.status` + counts from existing model — no new storage.

## API Design

### 1. Upload File

```
POST /api/ingest/:indexId/documents
Content-Type: multipart/form-data

Fields:
  - file: (binary) — Required for file upload
  - metadata: (JSON string) — Optional document metadata
  - permissions: (JSON string) — Optional ACL settings
```

### 2. Direct JSON Ingestion

```
POST /api/ingest/:indexId/documents
Content-Type: application/json

Body:
{
  "data": [ {...}, {...} ] | {...},  // JSON records to ingest
  "metadata": { "title": "...", ... },
  "permissions": {
    "publicEverywhere": false,
    "allowedUsers": ["user@example.com"],
    "allowedGroups": ["group:engineering"],
    "allowedDomains": ["example.com"]
  }
}
```

### 3. Status Check

```
GET /api/ingest/:indexId/documents/:documentId/status

Response:
{
  "documentId": "...",
  "status": "extracting" | "enriching" | "indexed" | "error",
  "progress": {
    "stage": "extraction",
    "percentage": 45
  },
  "pageCount": 12,
  "chunkCount": 48,
  "error": null,
  "createdAt": "...",
  "completedAt": null
}
```

### 4. Batch Status Check

```
GET /api/ingest/:indexId/documents/status?ids=doc1,doc2,doc3

Response:
{
  "documents": [
    { "documentId": "doc1", "status": "indexed", ... },
    { "documentId": "doc2", "status": "extracting", ... }
  ]
}
```

## Decisions & Tradeoffs

| #   | Decision            | Chose                                                                    | Over                                     | Reason                                                                                                      |
| --- | ------------------- | ------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Source resolution   | Auto-create "api-upload" source per index                                | Require sourceId in API                  | Simplifies external API — consumers shouldn't need to know internal source hierarchy                        |
| 2   | Permission storage  | Reuse `acl_document_permissions` collection                              | New collection                           | Already integrated with query-time permission filtering via `MongoPermissionStore`                          |
| 3   | Status tracking     | Poll-based GET endpoint                                                  | WebSocket                                | Matches `/query` pattern; ingestion takes seconds-to-minutes, not real-time enough to justify WS complexity |
| 4   | JSON body ingestion | Accept JSON in request body                                              | Only accept `.json` file upload          | Better DX for API consumers who generate data programmatically                                              |
| 5   | Route prefix        | `/api/ingest/:indexId/`                                                  | Add to existing `/api/indexes/:indexId/` | Separate concern: ingest API is public-facing; `/api/indexes/` is management                                |
| 6   | Permission format   | Flat `{ allowedUsers, allowedGroups, allowedDomains, publicEverywhere }` | Role-based (read/write/owner)            | Simpler for API consumers; read permission is the primary use case for search                               |

## Task Decomposition

| Task                                           | Package(s)                                      | Independent?       | Est. Files |
| ---------------------------------------------- | ----------------------------------------------- | ------------------ | ---------- |
| T-1: Ingestion route (file upload + JSON body) | `apps/search-ai`                                | Yes                | 3-4        |
| T-2: Permission-on-upload service              | `apps/search-ai`, `packages/search-ai-internal` | Yes                | 2-3        |
| T-3: Status endpoint (single + batch)          | `apps/search-ai`                                | Yes                | 1-2        |
| T-4: Wire routes + server mount                | `apps/search-ai`                                | No (T-1, T-2, T-3) | 1          |

## Out of Scope

- WebSocket/SSE real-time progress (existing `/progress` WebSocket covers crawl jobs)
- Batch file upload (multiple files in one request) — use multiple requests
- Custom pipeline selection per upload (future enhancement)
- UI changes in Studio (this is an API-only feature)
- Changing the existing internal upload route (`/api/indexes/:indexId/sources/:sourceId/documents`)

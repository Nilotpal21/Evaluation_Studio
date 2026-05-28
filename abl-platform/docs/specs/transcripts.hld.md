# HLD: Transcripts

**Feature Spec**: `docs/features/transcripts.md`
**Test Spec**: `docs/testing/transcripts.md`
**Status**: DRAFT
**Author**: Platform team
**Date**: 2026-03-23

---

## 1. Problem Statement

The platform has a prototype transcript feature (`apps/runtime/src/routes/transcripts.ts`) that stores conversation transcripts as JSON files on the local filesystem. This violates five core platform invariants:

1. **Stateless Distributed**: File storage is pod-local, invisible to other replicas
2. **Resource Isolation**: No tenant, project, or user scoping
3. **Centralized Auth**: No authentication middleware
4. **Compliance**: No encryption at rest, no PII handling, no retention policy
5. **Traceability**: Uses `console.error` instead of structured logging

Meanwhile, the pipeline-engine's `ConversationReader` already reads encrypted messages from MongoDB with retry logic and trace enrichment from ClickHouse. The transcript routes do not leverage this proven pattern.

**Goal**: Productionize transcript management with MongoDB-backed storage, three-level isolation (tenant/project/user), auth middleware, encryption at rest, and export capabilities (JSON + text).

---

## 2. Alternatives Considered

### Option A: Stored Transcript Model (MongoDB)

- **Description**: Create a new `Transcript` MongoDB collection. When a user saves a transcript, read session messages from the `messages` collection, compress them (gzip), encrypt (via `encryptionPlugin`), and store as a single document in `transcripts`. Export endpoints decompress and format.
- **Pros**: Transcript survives session/message purging. Annotatable (name, tags). Fast retrieval -- single document read. Leverages existing Mongoose plugins for tenant isolation and encryption. Consistent with platform patterns (Session, Message, Contact models).
- **Cons**: Duplicates message data (messages exist in both `messages` and `transcripts` collections). MongoDB 16MB document limit constrains maximum transcript size (mitigated by compression -- 1000 messages compress to approximately 100-200KB). Additional storage cost.
- **Effort**: M (Medium)

### Option B: Virtual Transcript (On-Demand Query)

- **Description**: No stored transcript collection. Export endpoints query `messages` collection filtered by `sessionId`, format them on the fly, and return. A "saved transcript" would just be a pointer (name + sessionId) without embedded content.
- **Pros**: Zero data duplication. No additional storage. Always reflects the latest message state (e.g., after PII scrubbing).
- **Cons**: Transcript disappears when session messages are purged (violates retention requirements). Every export re-reads and re-decrypts all messages. No ability to annotate or snapshot a point-in-time state. Slower for large sessions. Cannot guarantee transcript integrity across message lifecycle events.
- **Effort**: S (Small)

### Option C: Hybrid (Pointer + Materialized on Export)

- **Description**: Store a lightweight transcript document (metadata + pointer to sessionId). On read/export, materialize the full transcript by querying messages in real-time. Optionally cache the materialized result in the transcript document for subsequent reads.
- **Pros**: Low storage by default. Can still generate from live data. Cache avoids repeated decryption work.
- **Cons**: First-read latency is high (materialization). Cache invalidation is complex (when messages change). Still loses data when session messages are purged unless cache is populated first. Adds complexity without clear benefit over Option A.
- **Effort**: M (Medium)

### Recommendation: Option A — Stored Transcript Model

**Rationale**: The primary use case is creating a durable, named, exportable record of a conversation that persists beyond session and message lifecycle. Option A is the only approach that guarantees transcript integrity after message purging (GDPR right-to-erasure removes messages but transcript was already exported). The storage cost is minimal due to gzip compression (typically 70-85% reduction), and the MongoDB 16MB limit accommodates approximately 5,000-10,000 messages after compression. The pattern is consistent with how `session-state.model.ts` stores compressed `conversationHistory` as a Buffer field.

---

## 3. Architecture

### System Context Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                          Studio (Next.js)                          │
│                                                                    │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ SessionDetail    │  │ TranscriptsList  │  │ TranscriptDetail │  │
│  │ [Save] [Export]  │  │ [Filter] [Page]  │  │ [View] [Export]  │  │
│  └────────┬─────┬──┘  └────────┬─────────┘  └────────┬─────────┘  │
│           │     │              │                      │            │
│  ┌────────▼─────▼──────────────▼──────────────────────▼─────────┐  │
│  │          Studio API Routes (Next.js /api/projects/[id]/...)  │  │
│  └──────────────────────────────┬───────────────────────────────┘  │
└─────────────────────────────────┼──────────────────────────────────┘
                                  │ HTTP Proxy
┌─────────────────────────────────▼──────────────────────────────────┐
│                       Runtime (Express :3112)                      │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Auth Middleware  →  Rate Limiter  →  Project Scope         │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                             │                                      │
│  ┌──────────────────────────▼──────────────────────────────────┐   │
│  │          /api/projects/:projectId/transcripts               │   │
│  │  GET /       → list (paginated, filtered)                   │   │
│  │  POST /      → create from session                          │   │
│  │  GET /:id    → get detail                                   │   │
│  │  DELETE /:id → soft-delete                                  │   │
│  │  GET /:id/export?format=json|text → export                  │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                             │                                      │
│  ┌──────────────────────────▼──────────────────────────────────┐   │
│  │                  TranscriptService                          │   │
│  │  create() → read msgs + compress + store                    │   │
│  │  get()    → find + decompress                               │   │
│  │  list()   → query with filters                              │   │
│  │  delete() → set archivedAt                                  │   │
│  │  export() → decompress + format (JSON/text)                 │   │
│  └──────┬──────────────┬─────────────────┬─────────────────────┘   │
│         │              │                 │                          │
└─────────┼──────────────┼─────────────────┼──────────────────────────┘
          │              │                 │
  ┌───────▼────┐  ┌──────▼──────┐  ┌──────▼──────────┐
  │  MongoDB   │  │  MongoDB    │  │  ClickHouse     │
  │ transcripts│  │ messages    │  │ trace_events    │
  │ (new)      │  │ sessions    │  │ (read-only)     │
  └────────────┘  └─────────────┘  └─────────────────┘
```

### Component Diagram

```
apps/runtime/src/
├── routes/
│   ├── project-transcripts.ts    ← NEW: project-scoped router
│   └── transcripts.ts            ← EXISTING: deprecated (file-based)
├── services/
│   └── transcript-service.ts     ← NEW: service layer
├── middleware/
│   ├── auth.ts                   ← EXISTING: unifiedAuth middleware
│   └── rbac.ts                   ← EXISTING: requireProjectPermission

packages/database/src/models/
│   └── transcript.model.ts       ← NEW: Mongoose model

apps/studio/src/
├── app/api/projects/[id]/transcripts/
│   ├── route.ts                  ← NEW: list + create proxy
│   ├── [transcriptId]/
│   │   ├── route.ts              ← NEW: get + delete proxy
│   │   └── export/route.ts       ← NEW: export proxy
├── hooks/
│   ├── useTranscripts.ts         ← NEW: SWR list hook
│   └── useTranscriptDetail.ts    ← NEW: SWR detail hook
├── components/transcripts/
│   ├── TranscriptsListPage.tsx   ← NEW
│   └── TranscriptDetailPage.tsx  ← NEW
```

### Data Flow: Create Transcript

```
1. User clicks "Save Transcript" on SessionDetailPage
   │
2. Studio POST /api/projects/[id]/transcripts { sessionId, name }
   │
3. Studio proxy → Runtime POST /api/projects/:projectId/transcripts
   │
4. Auth middleware: verify JWT, extract tenantId, userId
   │
5. requireProjectPermission(req, res, 'transcript:write')
   │
6. TranscriptService.create(tenantId, projectId, sessionId, name, userId)
   │
   ├─ 6a. Query Session: findOne({ _id: sessionId, tenantId, projectId })
   │       → 404 if not found
   │
   ├─ 6b. Query Messages: find({ sessionId, tenantId }).sort({ timestamp: 1 })
   │       → Decrypt via encryptionPlugin (automatic on read)
   │
   ├─ 6c. Optionally query ClickHouse for trace event IDs
   │
   ├─ 6d. Compress messages array: gzip(JSON.stringify(messages))
   │
   ├─ 6e. Store Transcript document:
   │       {
   │         _id: uuidv7(),
   │         tenantId, projectId, sessionId,
   │         name: name || `${session.currentAgent}-${date}`,
   │         agentName: session.currentAgent,
   │         channel: session.channel,
   │         messageCount: messages.length,
   │         messages: compressedBuffer,  ← encrypted by encryptionPlugin
   │         traceEventIds: [...],
   │         metadata: { tokenCount, estimatedCost, duration },
   │         createdBy: userId,
   │         expiresAt: now + TTL_DAYS,
   │       }
   │
7. Return 201 { success: true, transcript: { id, name, messageCount } }
```

### Data Flow: Export Transcript

```
1. User clicks "Export as JSON" or "Export as Text"
   │
2. GET /api/projects/:projectId/transcripts/:id/export?format=json|text
   │
3. Auth + project permission check (transcript:read)
   │
4. TranscriptService.export(tenantId, projectId, id, format)
   │
   ├─ 4a. findOne({ _id: id, tenantId, projectId, archivedAt: null })
   │       → 404 if not found or archived
   │
   ├─ 4b. Decompress messages: gunzip(transcript.messages)
   │       → encryptionPlugin decrypts automatically on read
   │
   ├─ 4c. Format:
   │       ├── "json": return { messages, metadata, agentName, ... }
   │       └── "text": return formatted string with role labels + timestamps
   │
5. Return 200 with appropriate Content-Type header
   └── JSON: application/json
   └── Text: text/plain with Content-Disposition: attachment
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Tenant Isolation**    | `Transcript` model uses `tenantIsolationPlugin` (same as Session, Message). Every query includes `tenantId` via plugin injection. `findOne({ _id, tenantId })` pattern -- never `findById`. Cross-tenant access returns 404 to prevent existence leakage.                                                                                              |
| 2   | **Data Access Pattern** | Service layer pattern: `TranscriptService` encapsulates all MongoDB operations. Routes call service methods, never Mongoose models directly. Pattern follows `MongoConversationStore` (tenant-scoped ops via `withTenant()` wrapper). No caching layer initially -- transcript reads are infrequent and single-document lookups are fast with indexes. |
| 3   | **API Contract**        | Project-scoped REST: `GET/POST /api/projects/:projectId/transcripts`, `GET/DELETE /:id`, `GET /:id/export?format=json                                                                                                                                                                                                                                  | text`. Request/response shapes use Zod schemas registered with OpenAPI registry. Pagination: `{ total, transcripts: [...] }`. Detail: `{ success, transcript: {...} }`. Errors: `{ success: false, error: { code, message } }`. No API versioning needed (new endpoints).                                                                                                                                                                              |
| 4   | **Security Surface**    | Auth: `unifiedAuth` middleware (JWT verification) + `requireProjectPermission('transcript:read                                                                                                                                                                                                                                                         | write')`. Input validation: Zod schemas on request body (sessionId: `z.string().min(1)`, name: `z.string().max(255).optional()`). Path params: UUID format validated by Zod. No user-controlled data in file paths (unlike prototype). Encryption: `encryptionPlugin`on`messages`field (AES-256-GCM). PII: messages with`hasPII: true` flag are preserved as-is in transcript (PII scrubbing happens at the message level before transcript creation). |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Session not found: 404 `{ code: "NOT_FOUND", message: "Session not found: <id>" }`. Transcript not found: 404. Invalid format: 400 `{ code: "VALIDATION_ERROR" }`. Compression failure: 500 `{ code: "INTERNAL_ERROR" }` (logged with full context). Auth failure: 401/403 (handled by middleware). All errors logged via `createLogger('transcripts')` with request context.                                                                                                                           |
| 6   | **Failure Modes** | MongoDB unavailable: service returns 503, Express error handler catches. Encryption key missing: `encryptionPlugin` throws on save/read -- service catches and returns 500 with `ENCRYPTION_ERROR` code. Large session (>2000 messages): enforce `TRANSCRIPT_MAX_MESSAGES` limit, return 400 if exceeded. Decompression failure on read: return 500 with `DATA_CORRUPTION` code, log for investigation. ClickHouse unavailable: trace enrichment is optional -- skip and proceed without traceEventIds. |
| 7   | **Idempotency**   | Create: duplicate `(tenantId, projectId, sessionId, name)` returns the existing transcript instead of creating a duplicate. Enforced via unique compound index. Delete: soft-delete sets `archivedAt` -- calling delete again on an already-archived transcript returns 404 (consistent with "not found" semantics). Export: stateless read operation, inherently idempotent.                                                                                                                           |
| 8   | **Observability** | Logger: `createLogger('transcripts')` -- structured JSON logs. Key log points: `transcript.created` (info), `transcript.exported` (info, with format + size), `transcript.deleted` (info), `transcript.error` (error, with full context). Trace events: transcript creation emits a trace event to the `TraceStore` for audit trail. Metrics: `messageCount`, `compressedSize`, `exportDurationMs` logged per operation.                                                                                |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Create: <2s for sessions with <500 messages (p95). Dominated by message read + compression. Export: <5s for <1000 messages (p95). Dominated by decompression + formatting. List: <200ms with index-supported queries (p95). Storage: gzip typically achieves 70-85% compression on JSON text -- 1000 messages (~100KB raw) compress to ~15-30KB. MongoDB document limit of 16MB accommodates ~5000-10000 compressed messages.                                                                                                                                                          |
| 10  | **Migration Path**     | **Phase 1**: Deploy new `project-transcripts.ts` route alongside old `transcripts.ts`. New route at `/api/projects/:projectId/transcripts`, old route remains at `/api/v1/transcripts`. **Phase 2**: Add deprecation warning header to old route responses. **Phase 3**: Remove old route after confirming no consumers. No data migration needed -- the old route stored files on disk (ephemeral), not in a persistent store. The new `transcripts` MongoDB collection starts empty.                                                                                                 |
| 11  | **Rollback Plan**      | Feature is additive (new collection, new routes). Rollback = revert deployment (removes new routes, old `/api/v1/transcripts` route still works). New `transcripts` collection can be dropped without affecting any other feature. No foreign keys or cascading dependencies from other features into transcripts. The session/message collections are unmodified.                                                                                                                                                                                                                     |
| 12  | **Test Strategy**      | **Unit** (15+ tests): Model validation, name generation, compression round-trip, text formatter, static analysis for console calls. **Integration** (7+ tests): Service CRUD with real MongoDB (MongoMemoryServer), encryption round-trip, pagination, TTL, idempotency, cascade delete. **E2E** (8+ tests): Real Express server on random port, JWT auth tokens, tenant/project/user isolation, full lifecycle, pagination, structured content round-trip. All E2E tests interact via HTTP API only -- no direct DB access. See `docs/testing/transcripts.md` for full scenario list. |

---

## 5. Data Model

### New Collection: `transcripts`

```typescript
// packages/database/src/models/transcript.model.ts

interface ITranscript {
  _id: string; // UUIDv7
  tenantId: string; // Tenant isolation (required, indexed)
  projectId: string; // Project isolation (required, indexed)
  sessionId: string; // Source session reference (required)
  name: string; // User-provided or auto-generated (required)
  agentName: string; // Denormalized from session.currentAgent
  channel: string; // Denormalized from session.channel
  messageCount: number; // Denormalized count
  messages: Buffer; // gzip-compressed JSON array, encrypted by plugin
  traceEventIds: string[]; // ClickHouse trace event IDs (optional)
  metadata: {
    // Session metadata snapshot
    tokenCount?: number;
    estimatedCost?: number;
    durationMs?: number;
    environment?: string;
  };
  createdBy: string; // User ID who created the transcript
  contactId?: string; // Linked contact reference
  tags: string[]; // User-defined tags
  archivedAt?: Date; // Soft-delete timestamp
  expiresAt?: Date; // TTL expiration
  _v: number; // Schema version (default: 1)
  createdAt: Date; // Mongoose timestamp
  updatedAt: Date; // Mongoose timestamp
}
```

**Plugins**:

- `tenantIsolationPlugin` -- auto-injects `tenantId` in queries
- `encryptionPlugin` -- encrypts `messages` field with AES-256-GCM

**Indexes**:

| Index                                          | Type                        | Purpose                                     |
| ---------------------------------------------- | --------------------------- | ------------------------------------------- |
| `{ tenantId: 1, projectId: 1, createdAt: -1 }` | Compound                    | Primary listing query                       |
| `{ tenantId: 1, sessionId: 1, name: 1 }`       | Unique compound             | Idempotency (prevent duplicate transcripts) |
| `{ tenantId: 1, createdBy: 1, createdAt: -1 }` | Compound                    | User's transcripts query                    |
| `{ tenantId: 1, agentName: 1, createdAt: -1 }` | Compound                    | Filter by agent                             |
| `{ expiresAt: 1 }`                             | TTL (expireAfterSeconds: 0) | Auto-delete expired transcripts             |

### Modified Collections

None. Session and Message collections are read-only consumers.

### Key Relationships

```
Session (1) ←── reads from ──── (N) Transcript
  │                                    │
  └── Message (N) ←── snapshots ───────┘
                                       │
ClickHouse: trace_events ←── refs ─────┘
```

The transcript is a snapshot: it captures messages at creation time. Subsequent message updates (PII scrubbing, etc.) do not propagate to existing transcripts. This is intentional -- the transcript is a point-in-time record.

---

## 6. API Design

### New Endpoints

| Method | Path                                              | Purpose                        | Auth          | Permission         |
| ------ | ------------------------------------------------- | ------------------------------ | ------------- | ------------------ |
| GET    | `/api/projects/:projectId/transcripts`            | List transcripts (paginated)   | `unifiedAuth` | `transcript:read`  |
| POST   | `/api/projects/:projectId/transcripts`            | Create transcript from session | `unifiedAuth` | `transcript:write` |
| GET    | `/api/projects/:projectId/transcripts/:id`        | Get transcript detail          | `unifiedAuth` | `transcript:read`  |
| DELETE | `/api/projects/:projectId/transcripts/:id`        | Soft-delete transcript         | `unifiedAuth` | `transcript:write` |
| GET    | `/api/projects/:projectId/transcripts/:id/export` | Export in JSON or text format  | `unifiedAuth` | `transcript:read`  |

### Request/Response Schemas

**POST /transcripts** (Create)

```json
// Request
{ "sessionId": "sess-abc", "name": "My Transcript" }

// Response 201
{
  "success": true,
  "transcript": {
    "id": "01HX...",
    "name": "My Transcript",
    "agentName": "BookingAgent",
    "messageCount": 42,
    "createdAt": "2026-03-23T14:30:00Z"
  }
}
```

**GET /transcripts** (List)

```json
// Query: ?limit=20&offset=0&agentName=BookingAgent&channel=web_chat
// Response 200
{
  "success": true,
  "total": 85,
  "transcripts": [
    {
      "id": "01HX...",
      "name": "My Transcript",
      "agentName": "BookingAgent",
      "channel": "web_chat",
      "messageCount": 42,
      "createdAt": "2026-03-23T14:30:00Z",
      "createdBy": "user-123"
    }
  ]
}
```

**GET /transcripts/:id** (Detail)

```json
// Response 200
{
  "success": true,
  "transcript": {
    "id": "01HX...",
    "name": "My Transcript",
    "agentName": "BookingAgent",
    "channel": "web_chat",
    "messageCount": 42,
    "messages": [
      {
        "id": "msg-1",
        "role": "user",
        "content": "Book a hotel in Paris",
        "timestamp": "2026-03-23T14:30:01Z",
        "metadata": {}
      },
      {
        "id": "msg-2",
        "role": "assistant",
        "content": [
          { "type": "text", "text": "Searching for hotels..." },
          { "type": "tool_use", "id": "tu1", "name": "search_hotels", "input": { "city": "Paris" } }
        ],
        "timestamp": "2026-03-23T14:30:02Z",
        "metadata": { "tokens": { "input": 50, "output": 30 }, "latencyMs": 420 }
      }
    ],
    "metadata": { "tokenCount": 1200, "estimatedCost": 0.024, "durationMs": 45000 },
    "traceEventIds": ["te-1", "te-2"],
    "createdBy": "user-123",
    "createdAt": "2026-03-23T14:30:00Z"
  }
}
```

**GET /transcripts/:id/export?format=text** (Text Export)

```
Content-Type: text/plain
Content-Disposition: attachment; filename="BookingAgent-2026-03-23.txt"

=== Transcript: My Transcript ===
Agent: BookingAgent | Channel: web_chat | Date: 2026-03-23
Messages: 42 | Duration: 45s
---

[14:30:01] User: Book a hotel in Paris
[14:30:02] Assistant: Searching for hotels...
[14:30:02] [Tool: search_hotels({ city: "Paris" })]
[14:30:03] [Tool Result]: Found 3 hotels
[14:30:04] Assistant: Here are the hotels I found...
```

### Deprecated Endpoints

| Method | Path                      | Status     | Migration                                                                       |
| ------ | ------------------------- | ---------- | ------------------------------------------------------------------------------- |
| GET    | `/api/v1/transcripts`     | Deprecated | Add `Deprecation` + `Sunset` headers; consumers migrate to project-scoped route |
| GET    | `/api/v1/transcripts/:id` | Deprecated | Same                                                                            |
| POST   | `/api/v1/transcripts`     | Deprecated | Same                                                                            |
| DELETE | `/api/v1/transcripts/:id` | Deprecated | Same                                                                            |

### Error Responses

| Status | Code               | When                                                                 |
| ------ | ------------------ | -------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR` | Missing sessionId, invalid format, name too long, limit out of range |
| 401    | `UNAUTHORIZED`     | Missing or invalid auth token                                        |
| 403    | `FORBIDDEN`        | Insufficient project permissions                                     |
| 404    | `NOT_FOUND`        | Transcript/session not found, or cross-tenant/project access         |
| 409    | `CONFLICT`         | Message count exceeds `TRANSCRIPT_MAX_MESSAGES` limit                |
| 500    | `INTERNAL_ERROR`   | Compression failure, encryption error, database error                |

---

## 7. Cross-Cutting Concerns

### Audit Logging

- **transcript.created**: Log `{ transcriptId, sessionId, projectId, userId, messageCount }` at INFO level
- **transcript.exported**: Log `{ transcriptId, format, sizeBytes, durationMs, userId }` at INFO level
- **transcript.deleted**: Log `{ transcriptId, projectId, userId }` at INFO level
- **transcript.error**: Log full error context at ERROR level (no PII in log messages)

### Rate Limiting

- Transcript creation inherits the project-level rate limit from `tenantRateLimit` middleware
- Export endpoint: additional per-user rate limit of 30 requests/minute (export is more expensive than read due to decompression)
- List endpoint: standard pagination limit of 200 items per page

### Caching

- No caching in v1. Transcript reads are infrequent (save → review workflow, not real-time).
- Future optimization: Redis cache for recently-accessed transcripts if read volume increases.

### Encryption

- **At rest**: `messages` Buffer field encrypted by `encryptionPlugin` (AES-256-GCM with tenant-scoped keys)
- **In transit**: All API communication over HTTPS (enforced by infrastructure layer)
- **Export**: Decryption happens server-side during export; client receives plaintext JSON/text

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                                  | Type                        | Risk                                       |
| ----------------------------------------------------------- | --------------------------- | ------------------------------------------ |
| `packages/database` (Session, Message models)               | Data source                 | Low -- stable, well-tested                 |
| `packages/shared-auth` (createUnifiedAuthMiddleware)        | Auth                        | Low -- used across all routes              |
| `packages/shared` (encryptionPlugin, tenantIsolationPlugin) | Security                    | Low -- core platform infrastructure        |
| MongoDB                                                     | Data store                  | Low -- required for all platform features  |
| ClickHouse                                                  | Trace enrichment (optional) | Low -- graceful degradation if unavailable |

### Downstream (depends on this feature)

| Consumer                 | Impact                                                               |
| ------------------------ | -------------------------------------------------------------------- |
| Studio SessionDetailPage | "Save Transcript" button -- new UI integration                       |
| Studio navigation        | New "Transcripts" page in project sidebar                            |
| Pipeline Engine          | Could use stored transcripts instead of re-reading messages (future) |
| Archive Service          | Long-term transcript archival (future integration)                   |
| End-user SDK             | Transcript request endpoint (future, low priority)                   |

---

## 9. Open Questions & Decisions Needed

1. **Permission naming**: Should transcript permissions be `transcript:read` / `transcript:write`, or should they reuse `session:read` / `session:write`? Using separate permissions allows fine-grained control (e.g., grant transcript read but not session delete), but adds complexity to role definitions. **Recommendation**: Use `transcript:read` / `transcript:write` as separate permissions, default-granted to developer and admin roles.

2. **Maximum transcript size**: The `TRANSCRIPT_MAX_MESSAGES` limit (default 2000) prevents excessively large documents. Should this be a hard limit (reject) or soft limit (warn + truncate)? **Recommendation**: Hard limit with clear error message, since truncated transcripts would be misleading.

3. **ClickHouse trace enrichment**: Including `traceEventIds` in the transcript requires a ClickHouse query during creation. If ClickHouse is slow or unavailable, should creation fail or succeed without trace IDs? **Recommendation**: Succeed without trace IDs (log warning). Trace enrichment is optional metadata, not core transcript data.

4. **Old route deprecation timeline**: How long should the deprecated `/api/v1/transcripts` route remain available? **Recommendation**: 2 release cycles with `Deprecation` and `Sunset` headers, then removal.

---

## 10. References

- Feature spec: `docs/features/transcripts.md`
- Test spec: `docs/testing/transcripts.md`
- Existing prototype: `apps/runtime/src/routes/transcripts.ts`
- ConversationReader pattern: `packages/pipeline-engine/src/pipeline/services/conversation-reader.ts`
- Session state compressed buffer pattern: `packages/database/src/models/session-state.model.ts`
- Auth middleware: `apps/runtime/src/middleware/auth.ts`
- RBAC middleware: `apps/runtime/src/middleware/rbac.ts`
- Project-scoped route examples: `apps/runtime/src/routes/sessions.ts`, `apps/runtime/src/routes/alerts.ts`

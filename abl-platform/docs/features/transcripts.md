# Feature Spec: Transcripts

**Status**: PLANNED
**Owner**: Platform team
**Priority**: P1 (Backlog #72)
**Created**: 2026-03-23
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

Users need to save, retrieve, export, and manage conversation transcripts for debugging, compliance auditing, quality review, and training data extraction. The platform currently has a **prototype implementation** (`apps/runtime/src/routes/transcripts.ts`) that stores transcripts as JSON files on the local filesystem. This violates multiple platform invariants:

- **Stateless Distributed** (Core Invariant #3): File-based storage is pod-local and not shared across replicas.
- **Resource Isolation** (Core Invariant #1): No tenant, project, or user isolation — any caller can access any transcript.
- **Centralized Auth** (Core Invariant #2): No authentication or authorization middleware on transcript routes.
- **Compliance** (Core Invariant #5): No encryption at rest, no PII handling, no TTL/retention policy.
- **Traceability** (Core Invariant #4): Uses `console.error` instead of `createLogger`.

Meanwhile, `packages/pipeline-engine` already has a production-grade `ConversationReader` that reads encrypted messages from MongoDB and trace data from ClickHouse — but the runtime transcript routes do not use it.

### Goal Statement

Productionize the transcript feature by replacing file-based storage with MongoDB-backed persistence, enforcing tenant/project/user isolation, integrating with the existing encryption and auth infrastructure, and providing a Studio UI for transcript management.

### Summary

This feature covers:

1. A new `Transcript` MongoDB model with tenant/project isolation and encryption
2. Refactored runtime API routes with auth middleware, proper logging, and pagination
3. On-demand transcript generation from existing session/message data (no duplication)
4. Studio UI for viewing, saving, exporting, and managing transcripts
5. Export in multiple formats (JSON, plain text)
6. Retention policy integration (TTL, archival)

---

## 2. Scope

### Goals

- **G1**: Replace file-based transcript storage with MongoDB-backed persistence
- **G2**: Enforce tenant, project, and user isolation on all transcript operations
- **G3**: Add authentication and authorization to transcript API routes
- **G4**: Support on-demand transcript generation from session + message data
- **G5**: Provide transcript export in JSON and plain text formats
- **G6**: Integrate with Studio session detail page for save/export actions
- **G7**: Support pagination, filtering, and search on transcript listings
- **G8**: Enforce data lifecycle policies (TTL, PII handling, archival)

### Non-Goals

- **NG1**: Real-time streaming transcription (voice STT) — handled by `voice-pipeline.ts`
- **NG2**: PDF or rich document export — future enhancement
- **NG3**: Bulk transcript export scheduling (cron-based) — future enhancement
- **NG4**: Cross-tenant transcript sharing — violates isolation model
- **NG5**: Transcript editing/annotation — future enhancement
- **NG6**: Translation of transcript content — future enhancement

---

## 3. User Stories

### US-1: Developer saves session transcript from Studio

**As a** developer debugging an agent,
**I want to** save a transcript of a specific session from the Studio session detail page,
**So that** I can reference the full conversation later without needing the session to remain active.

**Acceptance Criteria:**

- A "Save Transcript" button appears on the session detail page
- Clicking it creates a named transcript linked to the session
- The transcript appears in a "Saved Transcripts" list within the project
- The transcript includes all messages, metadata, and optionally trace event references

### US-2: Operator exports transcript for quality review

**As a** quality assurance operator,
**I want to** export a conversation transcript in a structured format (JSON or text),
**So that** I can review agent performance offline or share with stakeholders.

**Acceptance Criteria:**

- Export button available on transcript detail view
- Supports JSON (full data) and plain text (human-readable) formats
- Export includes session metadata (agent name, channel, timestamps, message count)
- Downloaded file is named with agent name and date

### US-3: Admin manages transcript retention

**As a** platform administrator,
**I want to** configure how long saved transcripts are retained,
**So that** the system complies with data retention policies and storage is managed.

**Acceptance Criteria:**

- Transcripts have a configurable TTL (default: 90 days)
- Expired transcripts are automatically cleaned up
- Admin can extend or shorten retention per project
- PII-containing transcripts respect the scrubbing schedule

### US-4: Developer lists and filters saved transcripts

**As a** developer,
**I want to** browse saved transcripts filtered by agent, date range, or channel,
**So that** I can quickly find relevant conversations for debugging.

**Acceptance Criteria:**

- Transcript list page with pagination (default 20 per page)
- Filter by: agent name, date range, channel, session status
- Sort by: created date (default), message count, agent name
- Search by transcript name

### US-5: End-user requests conversation transcript

**As an** end-user interacting via web chat or API channel,
**I want to** request a transcript of my conversation,
**So that** I have a record of the interaction.

**Acceptance Criteria:**

- API endpoint to generate transcript for a specific session
- Response scoped to the requesting user's session only
- Plain text format suitable for email or display
- Respects PII scrubbing settings (scrubbed content shown as redacted)

---

## 4. Functional Requirements

| ID    | Requirement                                                                                                           | Priority | Testable Criteria                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| FR-1  | The system SHALL store transcripts in MongoDB with tenant isolation (`tenantId` in every query)                       | MUST     | Cross-tenant GET returns 404; transcript documents include `tenantId` field                |
| FR-2  | The system SHALL enforce project isolation (`projectId` scoping on all transcript routes)                             | MUST     | Transcript created in project A is not visible in project B                                |
| FR-3  | The system SHALL require authentication via `createUnifiedAuthMiddleware` on all transcript endpoints                 | MUST     | Unauthenticated requests return 401                                                        |
| FR-4  | The system SHALL generate transcripts on-demand from session + message data using the `ConversationReader` pattern    | MUST     | POST /transcripts with sessionId produces transcript from MongoDB messages, not file I/O   |
| FR-5  | The system SHALL support saving transcripts with a user-provided or auto-generated name                               | MUST     | POST with `name` uses it; POST without `name` auto-generates `{agentName}-{date}`          |
| FR-6  | The system SHALL paginate transcript listings with configurable `limit` and `offset`                                  | MUST     | GET /transcripts?limit=10&offset=20 returns correct page                                   |
| FR-7  | The system SHALL support filtering transcripts by agent name, channel, date range                                     | SHOULD   | GET /transcripts?agentName=X&channel=web_chat returns matching transcripts                 |
| FR-8  | The system SHALL export transcripts in JSON format (full structured data)                                             | MUST     | GET /transcripts/:id/export?format=json returns valid JSON with messages, metadata, traces |
| FR-9  | The system SHALL export transcripts in plain text format (human-readable)                                             | MUST     | GET /transcripts/:id/export?format=text returns formatted text transcript                  |
| FR-10 | The system SHALL encrypt transcript content at rest using the encryption plugin                                       | MUST     | Transcript `content` field in MongoDB is encrypted (AES-256-GCM)                           |
| FR-11 | The system SHALL enforce user isolation — users can only see transcripts they created or have permission to view      | SHOULD   | User A cannot see User B's saved transcripts unless shared                                 |
| FR-12 | The system SHALL support TTL-based expiration for transcripts                                                         | SHOULD   | Transcripts with `expiresAt` in the past are automatically removed                         |
| FR-13 | The system SHALL log all transcript operations using `createLogger('transcripts')` — no `console.log`/`console.error` | MUST     | Source code contains no `console.` calls; uses structured logger                           |
| FR-14 | The system SHALL return standard error envelope `{ success, error: { code, message } }` on failure                    | MUST     | All error responses match envelope format                                                  |
| FR-15 | The system SHALL support soft-delete with an `archivedAt` timestamp before permanent removal                          | SHOULD   | DELETE sets `archivedAt`; permanent removal after retention period                         |

---

## 5. Feature Classification & Integration Matrix

### Classification

| Attribute        | Value                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| Feature type     | Enhancement (productionizing prototype)                                           |
| Complexity       | Medium                                                                            |
| Affected layers  | API (Runtime), UI (Studio), Database, Pipeline Engine                             |
| Breaking changes | Yes — existing file-based API responses change to include `projectId`, pagination |

### Integration Matrix

| Related Feature          | Integration Point                                             | Direction      |
| ------------------------ | ------------------------------------------------------------- | -------------- |
| F003 - Sessions & Memory | Transcripts are generated FROM session + message data         | Reads from     |
| Pipeline Engine          | `ConversationReader` pattern for transcript generation        | Reuses         |
| Archive Service          | Long-term transcript archival via S3/local archive store      | Writes to      |
| Contacts                 | Transcripts linked to contacts via `contactId` from session   | References     |
| Compliance / PII         | Encryption at rest, PII scrubbing flags honored in export     | Enforces       |
| Guardrails               | Guardrail evaluation traces included in transcript trace data | References     |
| Studio Session Detail    | "Save Transcript" and "Export" actions on session detail page | UI integration |

---

## 6. How to Consume

### Studio UI

- **Session Detail Page** (`apps/studio/src/components/session/SessionDetailPage.tsx`): Add "Save Transcript" and "Export" action buttons
- **Transcripts List Page**: New page under project navigation showing saved transcripts with filters
- **Transcript Detail Page**: Read-only view of saved transcript with messages, metadata, and export options

### API — Runtime

| Method | Route                                             | Description                                            |
| ------ | ------------------------------------------------- | ------------------------------------------------------ |
| GET    | `/api/projects/:projectId/transcripts`            | List transcripts for a project (paginated, filterable) |
| GET    | `/api/projects/:projectId/transcripts/:id`        | Get transcript detail                                  |
| POST   | `/api/projects/:projectId/transcripts`            | Create transcript from session                         |
| DELETE | `/api/projects/:projectId/transcripts/:id`        | Soft-delete transcript                                 |
| GET    | `/api/projects/:projectId/transcripts/:id/export` | Export transcript in specified format                  |

### API — Studio (Proxy)

Studio Next.js API routes proxy to runtime:

| Method | Route                                                  | Description             |
| ------ | ------------------------------------------------------ | ----------------------- |
| GET    | `/api/projects/[id]/transcripts`                       | Proxy to runtime list   |
| GET    | `/api/projects/[id]/transcripts/[transcriptId]`        | Proxy to runtime detail |
| POST   | `/api/projects/[id]/transcripts`                       | Proxy to runtime create |
| DELETE | `/api/projects/[id]/transcripts/[transcriptId]`        | Proxy to runtime delete |
| GET    | `/api/projects/[id]/transcripts/[transcriptId]/export` | Proxy to runtime export |

### Admin

- Transcript retention policy configuration per tenant/project
- Bulk transcript deletion for compliance (right to erasure)

### Channels

- End-user transcript request via Web SDK or API channel (read-only, own session only)

---

## 7. Data Model

### Transcript Collection (`transcripts`)

| Field           | Type            | Required | Description                                               |
| --------------- | --------------- | -------- | --------------------------------------------------------- |
| `_id`           | String (UUIDv7) | Yes      | Primary key                                               |
| `tenantId`      | String          | Yes      | Tenant isolation                                          |
| `projectId`     | String          | Yes      | Project isolation                                         |
| `sessionId`     | String          | Yes      | Source session reference                                  |
| `name`          | String          | Yes      | User-provided or auto-generated name                      |
| `agentName`     | String          | Yes      | Agent that handled the session                            |
| `channel`       | String          | Yes      | Channel of the source session                             |
| `messageCount`  | Number          | Yes      | Denormalized message count                                |
| `format`        | String          | Yes      | `'saved'` (persisted) or `'export'` (one-time generation) |
| `messages`      | Buffer          | Yes      | Compressed + encrypted message array                      |
| `traceEventIds` | [String]        | No       | References to trace events (ClickHouse IDs)               |
| `metadata`      | Mixed           | No       | Session metadata snapshot (tokens, cost, duration)        |
| `createdBy`     | String          | Yes      | User who created the transcript                           |
| `contactId`     | String          | No       | Linked contact reference                                  |
| `tags`          | [String]        | No       | User-defined tags for organization                        |
| `archivedAt`    | Date            | No       | Soft-delete timestamp                                     |
| `expiresAt`     | Date            | No       | TTL expiration (MongoDB TTL index)                        |
| `_v`            | Number          | Yes      | Schema version                                            |
| `createdAt`     | Date            | Yes      | Mongoose timestamp                                        |
| `updatedAt`     | Date            | Yes      | Mongoose timestamp                                        |

### Indexes

| Index                                          | Purpose               |
| ---------------------------------------------- | --------------------- |
| `{ tenantId: 1, projectId: 1, createdAt: -1 }` | Primary listing query |
| `{ tenantId: 1, sessionId: 1 }`                | Lookup by session     |
| `{ tenantId: 1, createdBy: 1 }`                | User's transcripts    |
| `{ expiresAt: 1 }` (TTL)                       | Auto-expiration       |
| `{ tenantId: 1, agentName: 1, createdAt: -1 }` | Filter by agent       |

### Relationships

```
Session (1) --- (N) Transcript
  |                    |
  +-- Message (N)      +-- messages (embedded, compressed)
  |                    |
  +-- TraceEvent (N)   +-- traceEventIds (references)
```

---

## 8. Key Implementation Files

### Existing (to be refactored)

| File                                                   | Current State                           | Action                          |
| ------------------------------------------------------ | --------------------------------------- | ------------------------------- |
| `apps/runtime/src/routes/transcripts.ts`               | File-based CRUD, no auth, no isolation  | Rewrite with MongoDB + auth     |
| `apps/runtime/src/types/index.ts` (`TranscriptExport`) | Basic type definition                   | Align with new Transcript model |
| `apps/runtime/src/__tests__/transcript-routes.test.ts` | Unit tests with mocked fs               | Rewrite as integration tests    |
| `apps/runtime/src/server.ts` (line 370)                | Route mounting at `/api/v1/transcripts` | Change to project-scoped route  |

### New Files

| File                                                                               | Purpose                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/database/src/models/transcript.model.ts`                                 | Mongoose model with encryption + tenant isolation plugins          |
| `apps/runtime/src/services/transcript-service.ts`                                  | Service layer: create, get, list, delete, export                   |
| `apps/runtime/src/routes/project-transcripts.ts`                                   | Project-scoped routes under `/api/projects/:projectId/transcripts` |
| `apps/studio/src/app/api/projects/[id]/transcripts/route.ts`                       | Studio proxy route                                                 |
| `apps/studio/src/app/api/projects/[id]/transcripts/[transcriptId]/route.ts`        | Studio proxy detail route                                          |
| `apps/studio/src/app/api/projects/[id]/transcripts/[transcriptId]/export/route.ts` | Studio proxy export route                                          |
| `apps/studio/src/hooks/useTranscripts.ts`                                          | SWR hook for transcript list                                       |
| `apps/studio/src/hooks/useTranscriptDetail.ts`                                     | SWR hook for transcript detail                                     |
| `apps/studio/src/components/transcripts/TranscriptsListPage.tsx`                   | Studio transcript list page                                        |
| `apps/studio/src/components/transcripts/TranscriptDetailPage.tsx`                  | Studio transcript detail/view page                                 |

### Existing Files to Leverage

| File                                                                    | Usage                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/services/conversation-reader.ts` | Pattern for reading encrypted messages from MongoDB |
| `apps/runtime/src/services/stores/mongo-conversation-store.ts`          | Pattern for tenant-scoped MongoDB operations        |
| `apps/studio/src/repos/session-repo.ts`                                 | Pattern for Studio direct-DB read operations        |
| `apps/studio/src/components/session/SessionDetailPage.tsx`              | Add "Save Transcript" button here                   |

---

## 9. Configuration

### Environment Variables

| Variable                  | Default | Description                               |
| ------------------------- | ------- | ----------------------------------------- |
| `TRANSCRIPT_TTL_DAYS`     | `90`    | Default transcript retention in days      |
| `TRANSCRIPT_MAX_MESSAGES` | `2000`  | Maximum messages per transcript           |
| `TRANSCRIPT_COMPRESSION`  | `gzip`  | Compression algorithm for stored messages |

### Runtime Config

- Transcript feature is available when the `transcripts` route is mounted (no feature flag initially — the prototype is already mounted)
- Retention policy configurable per tenant via admin API

### DSL/IR

No DSL or IR changes required. Transcripts are an operational feature, not an agent behavior feature.

---

## 10. Non-Functional Concerns

### Tenant Isolation

- Every MongoDB query includes `tenantId` via the `tenantIsolationPlugin`
- Cross-tenant access returns 404 (not 403) to prevent existence leaking
- Uses `findOne({ _id, tenantId })` pattern, never `findById`

### Project Isolation

- All routes scoped under `/api/projects/:projectId/transcripts`
- Every query includes `projectId` in the filter
- `requireProjectPermission(req, res, 'transcript:read')` on read endpoints
- `requireProjectPermission(req, res, 'transcript:write')` on write endpoints

### User Isolation

- Saved transcripts include `createdBy` field
- List endpoint can filter by `createdBy` for "my transcripts" view
- Admin/operator roles can view all project transcripts

### Security

- Authentication via `createUnifiedAuthMiddleware` (no custom token verification)
- Message content encrypted at rest via `encryptionPlugin` (AES-256-GCM)
- Export endpoints validate authorization before decrypting content
- No PII exposed in error messages

### Performance

- Message content stored as compressed Buffer (gzip) to minimize storage
- Pagination required on list endpoints (max 200 per page)
- Transcript generation streams messages from MongoDB cursor (no full array in memory for large sessions)
- Indexes support all primary query patterns

### Reliability

- Transcript creation is idempotent (duplicate sessionId + name returns existing)
- Export is stateless — can be retried without side effects
- Soft-delete before permanent removal prevents accidental data loss

### Observability

- All operations logged via `createLogger('transcripts')`
- Transcript creation emits trace event for audit trail
- Export operations logged with format, size, and duration

### Data Lifecycle

- TTL index on `expiresAt` for automatic expiration
- Soft-delete via `archivedAt` timestamp
- Integration with archive service for long-term cold storage
- Right-to-erasure cascade: when a session is purged, associated transcripts are also purged

---

## 11. Delivery Plan / Work Breakdown

### Task 1: Database Model & Service Layer

1.1. Create `packages/database/src/models/transcript.model.ts` with schema, plugins, indexes
1.2. Create `apps/runtime/src/services/transcript-service.ts` with CRUD operations
1.3. Add transcript generation logic (read session + messages, compress, encrypt, store)
1.4. Add export logic (decompress, decrypt, format as JSON or text)
1.5. Unit tests for transcript service

### Task 2: Runtime API Routes

2.1. Create `apps/runtime/src/routes/project-transcripts.ts` with project-scoped routes
2.2. Wire auth middleware (`createUnifiedAuthMiddleware`, `requireProjectPermission`)
2.3. Wire route into `server.ts` under `/api/projects/:projectId/transcripts`
2.4. Deprecate old `/api/v1/transcripts` route (or redirect)
2.5. Integration tests for all endpoints (auth, isolation, CRUD, pagination)

### Task 3: Studio Proxy & Hooks

3.1. Create Studio API proxy routes (`/api/projects/[id]/transcripts/...`)
3.2. Create `useTranscripts` SWR hook for list with filters
3.3. Create `useTranscriptDetail` SWR hook for detail
3.4. Create transcript export download utility

### Task 4: Studio UI

4.1. Add "Save Transcript" button to `SessionDetailPage`
4.2. Create `TranscriptsListPage` component with table, filters, pagination
4.3. Create `TranscriptDetailPage` component with message viewer and export actions
4.4. Wire pages into Studio navigation

### Task 5: Retention & Compliance

5.1. Add TTL index and expiration logic
5.2. Add right-to-erasure cascade (session purge cascades to transcripts)
5.3. Admin API for retention policy configuration
5.4. Integration with archive service for cold storage

---

## 12. Success Metrics

| Metric                                                                                | Target          | Measurement                              |
| ------------------------------------------------------------------------------------- | --------------- | ---------------------------------------- |
| All transcript operations enforce tenant isolation                                    | 100%            | E2E tests verify cross-tenant 404        |
| Transcript creation from session completes in < 2s (for sessions with < 500 messages) | 95th percentile | Timing in trace events                   |
| Export endpoint returns response in < 5s for sessions with < 1000 messages            | 95th percentile | Timing in trace events                   |
| Zero `console.log`/`console.error` calls in transcript code                           | 0               | Static analysis                          |
| All endpoints require authentication                                                  | 100%            | E2E tests verify 401 for unauthenticated |

---

## 13. Open Questions

1. **Should transcripts store a full copy of messages or reference them by session ID?** Storing a copy ensures transcript integrity even after session messages are purged, but doubles storage. Current design: store compressed copy for saved transcripts, generate on-demand for exports.

2. **Should the old `/api/v1/transcripts` route be removed or deprecated with a redirect?** The route is already mounted in `server.ts` line 370. Removing it is a breaking change for any consumers.

3. **What permissions model for transcript access?** Options: (a) only creator can see saved transcripts, (b) all project members can see all project transcripts, (c) role-based (operator/admin sees all, developer sees own). Current design: role-based.

4. **Should transcript export support streaming for very large sessions?** For sessions with 1000+ messages, the export response could be large. Streaming (chunked transfer encoding) would reduce memory pressure.

5. **Integration with pipeline-engine's `ConversationReader`**: Should the transcript service directly import and use `ConversationReader`, or should it implement its own lighter-weight message reading? The `ConversationReader` has retry logic, ClickHouse trace enrichment, and encryption handling that would be valuable to reuse.

---

## 14. Gaps, Known Issues & Limitations

### Current Prototype Issues

| Issue                 | Severity | Description                                                                             |
| --------------------- | -------- | --------------------------------------------------------------------------------------- |
| File-based storage    | CRITICAL | `transcripts.ts` uses `fs.writeFile` to local filesystem — not distributed              |
| No authentication     | CRITICAL | Routes have no auth middleware — any HTTP client can CRUD transcripts                   |
| No tenant isolation   | CRITICAL | No `tenantId` scoping — all transcripts in a single directory                           |
| No project isolation  | CRITICAL | Routes at `/api/v1/transcripts` not under project scope                                 |
| `console.error` usage | HIGH     | Lines 93, 166, 260, 307 use `console.error` instead of `createLogger`                   |
| No encryption         | HIGH     | Transcript JSON files stored in plaintext on disk                                       |
| No pagination         | MEDIUM   | List endpoint returns all transcripts (unbounded)                                       |
| No PII handling       | HIGH     | Messages exported without PII scrubbing consideration                                   |
| Path traversal risk   | MEDIUM   | `req.params.id` used directly in file path (`${req.params.id}.json`) without validation |

### Known Limitations of Target Design

- Transcript content size limited by MongoDB document size (16MB) — mitigated by compression, but extremely long sessions (10,000+ messages) may need chunking
- ClickHouse trace data referenced by ID, not embedded — trace viewer needs separate fetch
- Voice channel transcripts (STT output) are handled by the voice pipeline, not this feature

---

## 15. Testing & Validation

### Unit Tests

- Transcript model validation (required fields, defaults, virtual fields)
- Transcript service logic (compression, decompression, format conversion)
- Name auto-generation logic

### Integration Tests (Minimum 5)

- IT-1: Create transcript from session with encrypted messages — verify decryption and re-encryption
- IT-2: List transcripts with pagination and filters — verify correct results and ordering
- IT-3: Export transcript in JSON format — verify complete data structure
- IT-4: Export transcript in text format — verify human-readable formatting
- IT-5: TTL expiration — verify transcript is removed after expiry
- IT-6: Soft-delete and permanent removal lifecycle

### E2E Tests (Minimum 5)

- E2E-1: **Tenant isolation**: Create transcript as tenant A, GET as tenant B returns 404
- E2E-2: **Project isolation**: Create transcript in project A, GET from project B returns 404
- E2E-3: **Auth enforcement**: GET /transcripts without auth token returns 401
- E2E-4: **Full lifecycle**: POST (create from session) -> GET (retrieve) -> GET /export (download) -> DELETE (soft-delete) -> GET (returns 404)
- E2E-5: **Pagination**: Create 25 transcripts, GET with limit=10&offset=0 returns first 10, offset=10 returns next 10
- E2E-6: **User isolation**: User A saves transcript, User B (same project, non-admin) cannot see it in their "my transcripts" list

All E2E tests use real HTTP API calls with proper auth tokens, tenant context, and project scoping. No mocks of codebase components.

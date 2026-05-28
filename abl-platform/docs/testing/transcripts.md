# Test Specification: Transcripts

**Feature Spec**: `docs/features/transcripts.md`
**HLD**: `docs/specs/transcripts.hld.md` (not yet created)
**LLD**: `docs/plans/2026-03-23-transcripts-impl-plan.md` (not yet created)
**Status**: PLANNED
**Last Updated**: 2026-03-23

---

## 1. Coverage Matrix

| FR    | Description                                         | Unit | Integration | E2E | Manual | Status  |
| ----- | --------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Tenant isolation (tenantId in every query)          | --   | --          | --  | --     | PLANNED |
| FR-2  | Project isolation (projectId scoping)               | --   | --          | --  | --     | PLANNED |
| FR-3  | Auth via createUnifiedAuthMiddleware                | --   | --          | --  | --     | PLANNED |
| FR-4  | On-demand generation from session + messages        | --   | --          | --  | --     | PLANNED |
| FR-5  | Named transcripts (user-provided or auto-generated) | --   | --          | --  | --     | PLANNED |
| FR-6  | Pagination (limit + offset)                         | --   | --          | --  | --     | PLANNED |
| FR-7  | Filtering (agent, channel, date range)              | --   | --          | --  | --     | PLANNED |
| FR-8  | JSON export (full structured data)                  | --   | --          | --  | --     | PLANNED |
| FR-9  | Plain text export (human-readable)                  | --   | --          | --  | --     | PLANNED |
| FR-10 | Encryption at rest (encryptionPlugin)               | --   | --          | --  | --     | PLANNED |
| FR-11 | User isolation (createdBy scoping)                  | --   | --          | --  | --     | PLANNED |
| FR-12 | TTL-based expiration                                | --   | --          | --  | --     | PLANNED |
| FR-13 | Structured logging (no console calls)               | --   | --          | --  | --     | PLANNED |
| FR-14 | Standard error envelope                             | --   | --          | --  | --     | PLANNED |
| FR-15 | Soft-delete with archivedAt                         | --   | --          | --  | --     | PLANNED |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers. All tests start real Express servers with full middleware chain (auth, rate limiting, tenant isolation, validation).

### E2E-1: Tenant Isolation — Cross-Tenant Access Returns 404

- **Preconditions**: Two tenants (tenant-A, tenant-B) exist. Tenant-A has a project with a session containing messages. A transcript has been created for that session by tenant-A.
- **Steps**:
  1. `POST /api/projects/:projectId/transcripts` as tenant-A user with `{ sessionId: "sess-1", name: "Tenant A Transcript" }` -- returns 201 with transcript `{ id, name }`
  2. `GET /api/projects/:projectId/transcripts/:transcriptId` as tenant-A user -- returns 200 with full transcript
  3. `GET /api/projects/:projectId/transcripts/:transcriptId` as tenant-B user (same transcriptId) -- returns 404 `{ success: false, error: { code: "NOT_FOUND" } }`
  4. `GET /api/projects/:projectId/transcripts` as tenant-B user with same projectId -- returns 200 with `{ total: 0, transcripts: [] }`
  5. `DELETE /api/projects/:projectId/transcripts/:transcriptId` as tenant-B user -- returns 404
- **Expected Result**: Tenant-B cannot see, list, or delete tenant-A's transcripts. Response is 404 (not 403) to avoid leaking existence.
- **Auth Context**: tenant-A token with `tenantId: "t-aaa"`, tenant-B token with `tenantId: "t-bbb"`, both with project access
- **Isolation Check**: Cross-tenant returns 404; response body contains no information about the real tenant's data
- **Covers**: FR-1

### E2E-2: Project Isolation — Cross-Project Access Returns 404

- **Preconditions**: One tenant with two projects (project-X, project-Y). Project-X has a session and transcript.
- **Steps**:
  1. `POST /api/projects/:projectXId/transcripts` with `{ sessionId: "sess-px", name: "Project X Transcript" }` -- returns 201
  2. `GET /api/projects/:projectXId/transcripts/:transcriptId` -- returns 200 with transcript data
  3. `GET /api/projects/:projectYId/transcripts/:transcriptId` -- returns 404
  4. `GET /api/projects/:projectYId/transcripts` -- returns 200 with `{ total: 0, transcripts: [] }` (no transcripts from project-X leak)
- **Expected Result**: Transcript created in project-X is invisible from project-Y context
- **Auth Context**: Same tenant, user with access to both projects
- **Isolation Check**: Cross-project returns 404
- **Covers**: FR-2

### E2E-3: Auth Enforcement — Unauthenticated Returns 401

- **Preconditions**: Runtime server running with auth middleware enabled
- **Steps**:
  1. `GET /api/projects/:projectId/transcripts` with NO auth header -- returns 401
  2. `GET /api/projects/:projectId/transcripts/:id` with NO auth header -- returns 401
  3. `POST /api/projects/:projectId/transcripts` with NO auth header and body `{ sessionId: "x" }` -- returns 401
  4. `DELETE /api/projects/:projectId/transcripts/:id` with NO auth header -- returns 401
  5. `GET /api/projects/:projectId/transcripts/:id/export?format=json` with NO auth header -- returns 401
  6. `GET /api/projects/:projectId/transcripts` with EXPIRED auth token -- returns 401
  7. `GET /api/projects/:projectId/transcripts` with MALFORMED auth token -- returns 401
- **Expected Result**: Every transcript endpoint rejects unauthenticated requests with 401. No data leakage in error response body.
- **Auth Context**: No token, expired token, malformed token
- **Isolation Check**: Error response body is `{ success: false, error: { code: "UNAUTHORIZED", message: "..." } }` -- no internal details
- **Covers**: FR-3

### E2E-4: Full CRUD Lifecycle — Create, Read, List, Export, Delete

- **Preconditions**: Authenticated user, project with an active session containing 5 messages (mix of user/assistant roles with structured content including `ContentBlock[]` arrays).
- **Steps**:
  1. **Create**: `POST /api/projects/:projectId/transcripts` with `{ sessionId: "sess-lifecycle", name: "Lifecycle Test" }` -- returns 201 with `{ success: true, transcript: { id, name: "Lifecycle Test", messageCount: 5 } }`
  2. **Read**: `GET /api/projects/:projectId/transcripts/:transcriptId` -- returns 200 with full transcript including `messages` array (5 items), each with `role`, `content`, `timestamp`; `metadata` with token counts; `agentName`
  3. **List**: `GET /api/projects/:projectId/transcripts` -- returns 200 with `{ total: 1, transcripts: [{ id, name, agentName, messageCount: 5, createdAt }] }`
  4. **Export JSON**: `GET /api/projects/:projectId/transcripts/:transcriptId/export?format=json` -- returns 200 with JSON body containing `messages`, `metadata`, `agentName`, `channel`, `createdAt`
  5. **Export Text**: `GET /api/projects/:projectId/transcripts/:transcriptId/export?format=text` -- returns 200 with `Content-Type: text/plain`, body contains `User: ...` / `Assistant: ...` formatted lines
  6. **Delete**: `DELETE /api/projects/:projectId/transcripts/:transcriptId` -- returns 200 with `{ success: true }`
  7. **Confirm Deleted**: `GET /api/projects/:projectId/transcripts/:transcriptId` -- returns 404
  8. **Confirm List Empty**: `GET /api/projects/:projectId/transcripts` -- returns 200 with `{ total: 0, transcripts: [] }`
- **Expected Result**: Complete CRUD lifecycle works end-to-end. Transcript accurately captures session messages including structured content types. Deleted transcript is no longer accessible.
- **Auth Context**: Valid tenant token, project member with `transcript:read` + `transcript:write` permissions
- **Isolation Check**: Only the created transcript appears in list; after delete, list is empty
- **Covers**: FR-4, FR-5, FR-8, FR-9, FR-14, FR-15

### E2E-5: Pagination and Filtering

- **Preconditions**: Authenticated user, project with 3 different agents (AgentA, AgentB, AgentC). 8 transcripts for AgentA (web_chat channel), 5 for AgentB (api channel), 2 for AgentC (voice channel) = 15 total.
- **Steps**:
  1. **Page 1**: `GET /api/projects/:projectId/transcripts?limit=5&offset=0` -- returns 200 with `{ total: 15, transcripts: [5 items] }`
  2. **Page 2**: `GET /api/projects/:projectId/transcripts?limit=5&offset=5` -- returns 200 with `{ total: 15, transcripts: [5 items] }`
  3. **Page 3**: `GET /api/projects/:projectId/transcripts?limit=5&offset=10` -- returns 200 with `{ total: 15, transcripts: [5 items] }`
  4. **Page 4 (empty)**: `GET /api/projects/:projectId/transcripts?limit=5&offset=15` -- returns 200 with `{ total: 15, transcripts: [] }`
  5. **Filter by agent**: `GET /api/projects/:projectId/transcripts?agentName=AgentB` -- returns 200 with `{ total: 5, transcripts: [5 items all with agentName: "AgentB"] }`
  6. **Filter by channel**: `GET /api/projects/:projectId/transcripts?channel=voice` -- returns 200 with `{ total: 2, transcripts: [2 items] }`
  7. **Combined filter + pagination**: `GET /api/projects/:projectId/transcripts?agentName=AgentA&limit=3&offset=0` -- returns 200 with `{ total: 8, transcripts: [3 items] }`
  8. **Verify ordering**: All list responses are sorted by `createdAt` descending (newest first)
- **Expected Result**: Pagination returns correct slices. Filters reduce result set accurately. Combined filter + pagination works. Total reflects filtered count, not page count.
- **Auth Context**: Valid tenant token, project member with `transcript:read`
- **Isolation Check**: No transcripts from other projects leak into results
- **Covers**: FR-6, FR-7

### E2E-6: User Isolation — Non-Admin Cannot See Other Users' Transcripts

- **Preconditions**: Tenant with one project. Two users: user-A (role: developer), user-B (role: developer). Both have project access. Admin user also exists.
- **Steps**:
  1. User-A creates transcript: `POST /api/projects/:projectId/transcripts` as user-A with `{ sessionId: "sess-ua", name: "User A's Transcript" }` -- returns 201
  2. User-B creates transcript: `POST /api/projects/:projectId/transcripts` as user-B with `{ sessionId: "sess-ub", name: "User B's Transcript" }` -- returns 201
  3. User-A lists own transcripts: `GET /api/projects/:projectId/transcripts?createdBy=me` -- returns 200 with `{ total: 1, transcripts: [{ name: "User A's Transcript" }] }`
  4. User-B lists own transcripts: `GET /api/projects/:projectId/transcripts?createdBy=me` -- returns 200 with `{ total: 1, transcripts: [{ name: "User B's Transcript" }] }`
  5. Admin lists all transcripts: `GET /api/projects/:projectId/transcripts` as admin -- returns 200 with `{ total: 2, transcripts: [...] }` (both visible)
  6. User-A gets user-B's transcript by ID: `GET /api/projects/:projectId/transcripts/:userBTranscriptId` as user-A -- returns 404 (unless project-wide read enabled)
- **Expected Result**: Developer-role users see only their own transcripts when filtering by `createdBy=me`. Admin sees all project transcripts. Cross-user direct access returns 404 for non-admin.
- **Auth Context**: Three different auth tokens (user-A developer, user-B developer, admin), same tenant, same project
- **Isolation Check**: User-A cannot access user-B's resources; admin can access all
- **Covers**: FR-11

### E2E-7: Error Envelope Consistency

- **Preconditions**: Authenticated user, valid project
- **Steps**:
  1. `GET /api/projects/:projectId/transcripts/nonexistent-id` -- returns 404 with `{ success: false, error: { code: "NOT_FOUND", message: "Transcript not found" } }`
  2. `POST /api/projects/:projectId/transcripts` with empty body `{}` -- returns 400 with `{ success: false, error: { code: "VALIDATION_ERROR", message: "..." } }`
  3. `POST /api/projects/:projectId/transcripts` with `{ sessionId: "nonexistent-session" }` -- returns 404 with `{ success: false, error: { code: "NOT_FOUND", message: "Session not found" } }`
  4. `GET /api/projects/:projectId/transcripts/:id/export?format=invalid` -- returns 400 with `{ success: false, error: { code: "VALIDATION_ERROR", message: "..." } }`
  5. `DELETE /api/projects/:projectId/transcripts/nonexistent-id` -- returns 404 with `{ success: false, error: { code: "NOT_FOUND", message: "..." } }`
- **Expected Result**: All error responses follow the standard envelope `{ success: false, error: { code, message } }`. No stack traces, no internal paths, no PII leaked in error messages.
- **Auth Context**: Valid authenticated user with project permissions
- **Isolation Check**: Error messages do not reveal existence of resources in other tenants/projects
- **Covers**: FR-14

### E2E-8: Structured Content Round-Trip (ContentBlock Arrays)

- **Preconditions**: Session with messages containing structured content -- `ContentBlock[]` arrays with text blocks, tool use blocks, and tool result blocks (not just plain strings).
- **Steps**:
  1. Seed a session with messages including:
     - User message: `"Book a hotel in Paris"`
     - Assistant message with `content: [{ type: "text", text: "Let me search..." }, { type: "tool_use", id: "tu1", name: "search_hotels", input: { city: "Paris" } }]`
     - Tool message: `content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "Found 3 hotels" }] }]`
     - Assistant message: `"Here are the hotels I found..."`
  2. `POST /api/projects/:projectId/transcripts` with `{ sessionId: "sess-structured" }` -- returns 201
  3. `GET /api/projects/:projectId/transcripts/:transcriptId` -- returns 200 with messages preserving `ContentBlock[]` structure
  4. `GET /api/projects/:projectId/transcripts/:transcriptId/export?format=json` -- returns JSON with structured content intact (not stringified or flattened)
  5. `GET /api/projects/:projectId/transcripts/:transcriptId/export?format=text` -- returns plain text with tool calls rendered as `[Tool: search_hotels({ city: "Paris" })]` or similar human-readable format
- **Expected Result**: Structured content types survive the create-store-retrieve-export round-trip. JSON export preserves exact structure. Text export renders tool calls readably.
- **Auth Context**: Valid authenticated user with project permissions
- **Isolation Check**: N/A (content integrity test)
- **Covers**: FR-4, FR-8, FR-9

---

## 3. Integration Test Scenarios (MANDATORY)

Integration tests verify service boundaries. Both sides of the boundary are real (not stubbed). Only external third-party services outside the service boundary may be mocked via dependency injection.

### INT-1: Transcript Service Creates from Session + Encrypted Messages

- **Boundary**: TranscriptService -> MongoConversationStore (MongoDB)
- **Setup**: MongoDB instance running (MongoMemoryServer for CI). Session document with 10 messages, all encrypted via `encryptionPlugin`. Encryption master key configured.
- **Steps**:
  1. Create a real `Session` document in MongoDB with `tenantId`, `projectId`, 10 `Message` documents with encrypted `content` field
  2. Call `transcriptService.createFromSession(tenantId, projectId, sessionId, { name: "Test" })`
  3. Verify returned transcript has `messageCount: 10`
  4. Read the transcript document directly from MongoDB
  5. Verify `messages` field is a compressed Buffer (not plaintext JSON)
  6. Decompress and decrypt -- verify all 10 messages recovered with correct roles and content
- **Expected Result**: Service reads encrypted messages, decrypts them, compresses, re-encrypts, and stores as a single transcript document. Round-trip produces identical content.
- **Failure Mode**: If encryption service unavailable, creation fails with clear error (not silent data loss)
- **Covers**: FR-4, FR-10

### INT-2: Transcript List with Pagination and Compound Filters

- **Boundary**: TranscriptService -> Transcript Model (MongoDB)
- **Setup**: MongoDB with 20 transcript documents across 2 agents, 3 channels, spanning 30 days of `createdAt` dates
- **Steps**:
  1. Insert 20 transcripts: 10 for "AgentA" (5 web_chat, 5 api), 10 for "AgentB" (5 voice, 5 web_chat)
  2. `transcriptService.list(tenantId, projectId, { limit: 5, offset: 0 })` -- returns 5 items, total: 20
  3. `transcriptService.list(tenantId, projectId, { agentName: "AgentA" })` -- returns 10 items
  4. `transcriptService.list(tenantId, projectId, { agentName: "AgentA", channel: "web_chat" })` -- returns 5 items
  5. `transcriptService.list(tenantId, projectId, { dateFrom: "2026-03-10", dateTo: "2026-03-20" })` -- returns subset matching date range
  6. Verify results sorted by `createdAt` descending
  7. Verify `tenantId` and `projectId` always included in underlying MongoDB query (inspect query via Mongoose debug or verify by inserting cross-tenant data that does not appear)
- **Expected Result**: Compound filters compose correctly. Pagination returns accurate slices. Tenant/project scoping never omitted.
- **Failure Mode**: If filter field is undefined, it is not included in query (does not filter by `undefined`)
- **Covers**: FR-6, FR-7, FR-1, FR-2

### INT-3: JSON Export with Full Data Structure

- **Boundary**: TranscriptService.export -> Transcript Model (MongoDB) -> Decompression/Decryption
- **Setup**: Transcript document in MongoDB with compressed/encrypted messages containing a mix of roles (user, assistant, system, tool) and structured metadata (token counts, latency, model name)
- **Steps**:
  1. Create transcript with 5 messages including:
     - `{ role: "system", content: "You are a booking assistant" }`
     - `{ role: "user", content: "Book a room" }`
     - `{ role: "assistant", content: "Sure, checking availability...", metadata: { tokens: { input: 50, output: 30 }, latencyMs: 420 } }`
     - `{ role: "tool", content: "[{\"type\":\"tool_result\",\"content\":\"Available\"}]" }`
     - `{ role: "assistant", content: "Room booked!" }`
  2. `transcriptService.export(tenantId, projectId, transcriptId, "json")` -- returns structured JSON
  3. Verify JSON contains: `messages` array with all 5 entries, `metadata` with session-level data, `agentName`, `channel`, `createdAt`
  4. Verify each message has: `role`, `content`, `timestamp` (ISO string)
  5. Verify metadata fields preserved: `tokens`, `latencyMs`
- **Expected Result**: JSON export is a complete representation of the transcript, suitable for reimport or analysis tooling. No data loss or truncation.
- **Failure Mode**: If decompression fails, returns error with `code: "INTERNAL_ERROR"`, not partial data
- **Covers**: FR-8

### INT-4: Plain Text Export Formatting

- **Boundary**: TranscriptService.export -> Format conversion logic
- **Setup**: Transcript with 4 messages including tool call content
- **Steps**:
  1. Create transcript with messages:
     - `{ role: "user", content: "What's the weather?" }`
     - `{ role: "assistant", content: "Let me check for you." }`
     - `{ role: "tool", content: "{\"temperature\": 22, \"condition\": \"sunny\"}" }`
     - `{ role: "assistant", content: "It's 22 degrees and sunny." }`
  2. `transcriptService.export(tenantId, projectId, transcriptId, "text")` -- returns string
  3. Verify output contains:
     - Header line with agent name, date, channel
     - `User: What's the weather?`
     - `Assistant: Let me check for you.`
     - `[Tool Result]: {"temperature": 22, "condition": "sunny"}`
     - `Assistant: It's 22 degrees and sunny.`
  4. Verify timestamps are present in human-readable format (e.g., `[2026-03-23 14:30:05]`)
  5. Verify no encrypted or compressed artifacts in output
- **Expected Result**: Text export is human-readable, correctly labels each role, includes timestamps, and handles tool content appropriately.
- **Failure Mode**: Tool content that is not valid JSON is rendered as-is (no crash)
- **Covers**: FR-9

### INT-5: Soft-Delete and TTL Expiration

- **Boundary**: TranscriptService -> Transcript Model (MongoDB TTL index)
- **Setup**: MongoDB with TTL monitor running (or simulated). Two transcripts: one with `expiresAt` in the past, one with `expiresAt` in the future.
- **Steps**:
  1. Create transcript-A with `expiresAt: new Date(Date.now() - 1000)` (already expired)
  2. Create transcript-B with `expiresAt: new Date(Date.now() + 86400000)` (expires tomorrow)
  3. `transcriptService.delete(tenantId, projectId, transcriptAId)` -- returns success, sets `archivedAt` timestamp
  4. `transcriptService.get(tenantId, projectId, transcriptAId)` -- returns 404 (soft-deleted)
  5. `transcriptService.get(tenantId, projectId, transcriptBId)` -- returns 200 (still active)
  6. Verify in MongoDB that transcript-A document still exists with `archivedAt` set (not physically removed yet)
  7. Wait for TTL monitor to process (or query with TTL-aware filter) -- verify expired document is eventually removed
- **Expected Result**: Soft-delete sets `archivedAt` and hides from API queries. TTL index handles physical removal of expired documents. Non-expired transcripts unaffected.
- **Failure Mode**: If TTL index not created, documents persist indefinitely (detectable by checking index presence)
- **Covers**: FR-12, FR-15

### INT-6: Idempotent Transcript Creation

- **Boundary**: TranscriptService -> Transcript Model (MongoDB unique constraint)
- **Setup**: MongoDB with session and messages
- **Steps**:
  1. `transcriptService.createFromSession(tenantId, projectId, sessionId, { name: "Idempotent Test" })` -- returns transcript with id-1
  2. `transcriptService.createFromSession(tenantId, projectId, sessionId, { name: "Idempotent Test" })` -- returns same transcript with id-1 (not a duplicate)
  3. `transcriptService.list(tenantId, projectId, {})` -- total is 1, not 2
  4. `transcriptService.createFromSession(tenantId, projectId, sessionId, { name: "Different Name" })` -- returns NEW transcript with id-2 (different name = different transcript)
- **Expected Result**: Duplicate creation with same sessionId + name returns existing transcript. Different name creates a new one.
- **Failure Mode**: Without idempotency check, duplicate documents created (detectable by count)
- **Covers**: FR-4, FR-5

### INT-7: Right-to-Erasure Cascade

- **Boundary**: Session deletion -> Transcript cascade deletion
- **Setup**: Session with 3 associated transcripts in MongoDB
- **Steps**:
  1. Create session with messages
  2. Create 3 transcripts from the session with different names
  3. Verify all 3 transcripts visible in list
  4. Trigger session purge (right-to-erasure cascade)
  5. Verify all 3 transcripts are removed (hard delete, not soft delete, per GDPR)
  6. Verify no orphaned transcript documents remain
- **Expected Result**: When a session is purged for compliance, all associated transcripts are also permanently deleted (not just soft-deleted).
- **Failure Mode**: Cascade fails silently, leaving orphaned transcripts with PII
- **Covers**: FR-1 (data lifecycle), FR-15

---

## 4. Unit Test Scenarios

### UT-1: Name Auto-Generation

- **Module**: `transcript-service.ts` — name generation logic
- **Input**: `agentName: "BookingAgent"`, `date: new Date("2026-03-23T14:30:00Z")`
- **Expected Output**: `"BookingAgent-2026-03-23"`

### UT-2: Name Auto-Generation with Special Characters

- **Module**: `transcript-service.ts` — name generation logic
- **Input**: `agentName: "My Agent (v2)"`, `date: new Date("2026-03-23")`
- **Expected Output**: `"My Agent (v2)-2026-03-23"` (preserves agent name as-is)

### UT-3: Transcript Model Validation — Required Fields

- **Module**: `transcript.model.ts` — Mongoose validation
- **Input**: Document missing `tenantId`, `projectId`, `sessionId`, `name`, `agentName`, `createdBy`
- **Expected Output**: Validation error listing all missing required fields

### UT-4: Transcript Model Validation — Valid Document

- **Module**: `transcript.model.ts` — Mongoose validation
- **Input**: Complete document with all required fields, messages as Buffer, valid channel enum
- **Expected Output**: Validation passes, document saves successfully

### UT-5: Text Formatter — Role Labels

- **Module**: `transcript-service.ts` — text format conversion
- **Input**: Messages with roles `user`, `assistant`, `system`, `tool`
- **Expected Output**: Text output labels as `User:`, `Assistant:`, `System:`, `[Tool Result]:`

### UT-6: Text Formatter — Empty Messages Array

- **Module**: `transcript-service.ts` — text format conversion
- **Input**: Empty messages array `[]`
- **Expected Output**: Header line with metadata, no message lines, footer with "0 messages"

### UT-7: Compression Round-Trip

- **Module**: `transcript-service.ts` — compress/decompress logic
- **Input**: Array of 100 message objects (approx 50KB uncompressed)
- **Expected Output**: Compressed Buffer is smaller than input JSON string; decompressed output matches original exactly

### UT-8: Static Analysis — No Console Calls

- **Module**: All transcript source files
- **Input**: Source code of `transcript-service.ts`, `project-transcripts.ts`, `transcript.model.ts`
- **Expected Output**: No occurrences of `console.log`, `console.error`, `console.warn`, `console.info`
- **Covers**: FR-13

---

## 5. Security & Isolation Tests

### Tenant Isolation

- [x] Cross-tenant GET transcript returns 404 (E2E-1)
- [x] Cross-tenant LIST returns empty set (E2E-1)
- [x] Cross-tenant DELETE returns 404 (E2E-1)
- [ ] Verify MongoDB queries always include `tenantId` in filter (code review / static analysis)
- [ ] Verify tenant isolation plugin is applied to Transcript model

### Project Isolation

- [x] Cross-project GET returns 404 (E2E-2)
- [x] Cross-project LIST returns empty set (E2E-2)
- [ ] Verify `requireProjectPermission` middleware on all transcript routes
- [ ] Verify `projectId` is in every MongoDB query (code review)

### User Isolation

- [x] Developer cannot see other developer's transcripts in "my" view (E2E-6)
- [x] Admin can see all project transcripts (E2E-6)
- [ ] Verify `createdBy` filter applied when `createdBy=me` query param present

### Authentication

- [x] No auth token returns 401 on all endpoints (E2E-3)
- [x] Expired token returns 401 (E2E-3)
- [x] Malformed token returns 401 (E2E-3)

### Authorization

- [ ] Viewer role can read but not create/delete transcripts
- [ ] Developer role can read and create but permissions are role-scoped
- [ ] Admin role has full access

### Input Validation

- [x] Empty body on POST returns 400 (E2E-7)
- [x] Invalid export format returns 400 (E2E-7)
- [ ] Overly long name (> 255 chars) returns 400
- [ ] sessionId with path traversal characters (`../`) returns 400
- [ ] limit > 200 is clamped to 200
- [ ] offset < 0 returns 400

---

## 6. Performance & Load Tests

### PERF-1: Large Session Transcript Creation

- **Scenario**: Create transcript from session with 1000 messages
- **Target**: < 2 seconds (p95)
- **Measurement**: Record duration from POST request to 201 response

### PERF-2: Large Transcript Export

- **Scenario**: Export transcript with 1000 messages in JSON format
- **Target**: < 5 seconds (p95)
- **Measurement**: Record duration from GET request to complete response

### PERF-3: List Endpoint Under Load

- **Scenario**: 500 transcripts in project, 50 concurrent list requests with different pagination offsets
- **Target**: < 500ms per request (p95)
- **Measurement**: Concurrent HTTP requests, measure response times

### PERF-4: Compression Ratio

- **Scenario**: Measure compression ratio for typical transcripts (100, 500, 1000 messages)
- **Target**: > 70% compression ratio (gzip level 6)
- **Measurement**: Compare raw JSON size vs compressed Buffer size

---

## 7. Test Infrastructure

### Required Services

| Service | Usage                                     | Setup                                                        |
| ------- | ----------------------------------------- | ------------------------------------------------------------ |
| MongoDB | Transcript, Session, Message storage      | MongoMemoryServer for unit/integration; real MongoDB for E2E |
| Redis   | Session state (for active session lookup) | Redis container or mock for unit tests                       |
| Express | Runtime HTTP server                       | `{ port: 0 }` for random port allocation                     |

### Data Seeding

- **Sessions**: Use `MongoConversationStore.create()` or direct `Session.create()` with required fields (`tenantId`, `projectId`, `currentAgent`, `channel`, `status`)
- **Messages**: Use `Message.create()` with encrypted content (via `encryptionPlugin`)
- **Auth tokens**: Generate test JWT tokens with `tenantId`, `userId`, `projectId`, and role claims
- **Multiple tenants**: Seed 2+ tenants with separate projects for isolation tests

### Environment Variables

| Variable                  | Test Value                       | Purpose                        |
| ------------------------- | -------------------------------- | ------------------------------ |
| `ENCRYPTION_MASTER_KEY`   | `test-key-32-bytes-long-for-aes` | Enable encryption plugin       |
| `TRANSCRIPT_TTL_DAYS`     | `1`                              | Short TTL for expiration tests |
| `TRANSCRIPT_MAX_MESSAGES` | `2000`                           | Message limit validation       |
| `NODE_ENV`                | `test`                           | Test mode                      |

### CI Configuration

- E2E tests run in a separate CI step with MongoDB and Redis services
- Unit and integration tests run in standard `pnpm test` pipeline
- E2E test files located at `apps/runtime/src/__tests__/e2e/transcripts-*.test.ts`
- Integration test files at `apps/runtime/src/__tests__/integration/transcripts-*.test.ts`

---

## 8. Test File Mapping

| Test File                                                           | Type        | Covers                                          |
| ------------------------------------------------------------------- | ----------- | ----------------------------------------------- |
| `packages/database/src/__tests__/transcript-model.test.ts`          | unit        | FR-1 (model), FR-10, UT-3, UT-4                 |
| `apps/runtime/src/__tests__/transcript-service.test.ts`             | unit        | FR-5, FR-13, UT-1, UT-2, UT-5, UT-6, UT-7, UT-8 |
| `apps/runtime/src/__tests__/integration/transcript-service.test.ts` | integration | INT-1, INT-2, INT-3, INT-4, INT-5, INT-6, INT-7 |
| `apps/runtime/src/__tests__/transcripts-authz.test.ts`              | integration | FR-3, E2E-3 (auth patterns)                     |
| `apps/runtime/src/__tests__/e2e/transcripts-isolation.test.ts`      | e2e         | E2E-1, E2E-2, E2E-6                             |
| `apps/runtime/src/__tests__/e2e/transcripts-lifecycle.test.ts`      | e2e         | E2E-4, E2E-7, E2E-8                             |
| `apps/runtime/src/__tests__/e2e/transcripts-pagination.test.ts`     | e2e         | E2E-5                                           |

---

## 9. Open Testing Questions

1. **MongoMemoryServer vs real MongoDB for integration tests?** The platform uses MongoMemoryServer for some tests (search-ai) but real MongoDB for others. For transcript encryption tests, MongoMemoryServer may not support the encryption plugin correctly.

2. **How to test TTL expiration in CI?** MongoDB TTL monitor runs every 60 seconds. For CI tests, either: (a) wait 60+ seconds (slow), (b) set TTL index to 1 second and wait, or (c) verify the TTL index exists and test soft-delete separately.

3. **Auth token generation for E2E tests**: Need a test utility to generate valid JWT tokens with specific tenant/project/role claims. Check if `packages/shared-auth` has test helpers.

4. **Existing test patterns for session seeding**: The `sessions-authz.test.ts` pattern mocks auth and openapi. For E2E tests, we need real middleware -- need to verify if there's a test helper that sets up a full Express app with auth.

5. **ClickHouse dependency for trace enrichment**: If transcript export includes trace event data, integration tests may need ClickHouse. This could be optional (trace enrichment disabled in tests) or require a ClickHouse test container.

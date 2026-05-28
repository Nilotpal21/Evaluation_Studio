# LLD: Transcripts

**Feature Spec**: `docs/features/transcripts.md`
**HLD**: `docs/specs/transcripts.hld.md`
**Test Spec**: `docs/testing/transcripts.md`
**Status**: DRAFT
**Date**: 2026-03-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                        | Rationale                                                                                                             | Alternatives Rejected                                                               |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| D-1 | Store compressed messages as Buffer in Transcript document      | Survives session/message purging; consistent with `session-state.model.ts` pattern for `conversationHistory`          | Virtual query (loses data on purge), Hybrid pointer (unnecessary complexity)        |
| D-2 | Service layer pattern (`TranscriptService` class)               | Follows `MongoConversationStore` pattern; keeps route handlers thin; testable in isolation                            | Direct Mongoose calls in routes (violates service extraction pattern from Sprint 3) |
| D-3 | Project-scoped routes at `/api/projects/:projectId/transcripts` | Consistent with all other project resources (`sessions`, `agents`, `deployments`); enables `requireProjectPermission` | Keep `/api/v1/transcripts` (no project isolation, violates Core Invariant #1)       |
| D-4 | gzip compression for message storage                            | Built-in Node.js `zlib`, 70-85% reduction typical, consistent with `session-state.model.ts`                           | No compression (wastes storage), brotli (more CPU, marginal gain for JSON)          |
| D-5 | Separate `transcript:read` / `transcript:write` permissions     | Fine-grained RBAC; does not overload existing session permissions                                                     | Reuse `session:read/write` (conflates transcript and session access)                |
| D-6 | Export as static route `/export` before parameterized `/:id`    | Express route ordering: static routes must precede parameterized to prevent `export` being captured as an `:id` value | Route `/:id` first (would match `export` as an ID string)                           |

### Key Interfaces & Types

```typescript
// packages/database/src/models/transcript.model.ts
export interface ITranscript {
  _id: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  name: string;
  agentName: string;
  channel: string;
  messageCount: number;
  messages: Buffer; // gzip-compressed, encrypted by plugin
  traceEventIds: string[];
  metadata: Record<string, unknown>;
  createdBy: string;
  contactId: string | null;
  tags: string[];
  archivedAt: Date | null;
  expiresAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// apps/runtime/src/services/transcript-service.ts
export interface TranscriptCreateParams {
  sessionId: string;
  name?: string;
  tags?: string[];
}

export interface TranscriptListParams {
  limit?: number;
  offset?: number;
  agentName?: string;
  channel?: string;
  dateFrom?: string;
  dateTo?: string;
  createdBy?: string;
}

export interface TranscriptExportResult {
  content: string | object;
  contentType: string;
  filename: string;
}
```

### Module Boundaries

| Module                   | Responsibility                                    | Depends On                                                           |
| ------------------------ | ------------------------------------------------- | -------------------------------------------------------------------- |
| `transcript.model.ts`    | Mongoose schema, validation, indexes, plugins     | `tenantIsolationPlugin`, `encryptionPlugin`, `uuidv7`                |
| `TranscriptService`      | Business logic: create, get, list, delete, export | `Transcript` model, `Session` model, `Message` model, `createLogger` |
| `project-transcripts.ts` | HTTP route handling, Zod validation, auth         | `TranscriptService`, `requireProjectPermission`, `unifiedAuth`       |
| Studio proxy routes      | HTTP proxy to runtime                             | Runtime API (HTTP)                                                   |
| Studio hooks             | SWR data fetching                                 | Studio proxy routes                                                  |
| Studio UI components     | User interface                                    | Studio hooks, design system                                          |

---

## 2. File-Level Change Map

### New Files

| File                                                                               | Purpose                                          | LOC Estimate |
| ---------------------------------------------------------------------------------- | ------------------------------------------------ | ------------ |
| `packages/database/src/models/transcript.model.ts`                                 | Mongoose model with schema, plugins, indexes     | ~120         |
| `apps/runtime/src/services/transcript-service.ts`                                  | Service layer: create, get, list, delete, export | ~300         |
| `apps/runtime/src/routes/project-transcripts.ts`                                   | Project-scoped API routes with auth, validation  | ~250         |
| `apps/runtime/src/__tests__/transcript-service.test.ts`                            | Unit tests for service logic                     | ~200         |
| `apps/runtime/src/__tests__/transcripts-authz.test.ts`                             | Auth/RBAC integration tests                      | ~250         |
| `apps/studio/src/app/api/projects/[id]/transcripts/route.ts`                       | Studio proxy: list + create                      | ~60          |
| `apps/studio/src/app/api/projects/[id]/transcripts/[transcriptId]/route.ts`        | Studio proxy: get + delete                       | ~60          |
| `apps/studio/src/app/api/projects/[id]/transcripts/[transcriptId]/export/route.ts` | Studio proxy: export                             | ~40          |
| `apps/studio/src/hooks/useTranscripts.ts`                                          | SWR hook for transcript list                     | ~50          |
| `apps/studio/src/hooks/useTranscriptDetail.ts`                                     | SWR hook for transcript detail                   | ~40          |

### Modified Files

| File                                                               | Change Description                                                              | Risk |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ---- |
| `packages/database/src/models/index.ts`                            | Add `export { Transcript, type ITranscript }` line                              | Low  |
| `apps/runtime/src/server.ts`                                       | Add `app.use('/api/projects/:projectId/transcripts', projectTranscriptsRouter)` | Low  |
| `apps/runtime/src/routes/transcripts.ts`                           | Add deprecation headers to existing responses                                   | Low  |
| `apps/runtime/src/middleware/rbac.ts` (`PROJECT_ROLE_PERMISSIONS`) | Add `transcript:read` and `transcript:write` to role mappings                   | Low  |

### Deleted Files

None. The old `transcripts.ts` is deprecated but preserved for backward compatibility.

---

## 3. Implementation Phases

### Phase 1: Data Layer — Transcript Model

**Goal**: Create the Mongoose Transcript model with all plugins, indexes, and validation.

**Tasks**:

1.1. Create `packages/database/src/models/transcript.model.ts`:

- Define `ITranscript` interface with all fields per HLD section 5
- Create Mongoose schema with `tenantIsolationPlugin` and `encryptionPlugin` (`fieldsToEncrypt: ['messages']`)
- Add UUIDv7 default for `_id`
- Add 5 indexes per HLD: listing, idempotency (unique), user, agent, TTL
- Guard against HMR OverwriteModelError (`mongoose.models['Transcript'] || model(...)`)

  1.2. Add export to `packages/database/src/models/index.ts`:

- Add line: `export { Transcript, type ITranscript } from './transcript.model.js';`
- Place alongside Session/Message exports for logical grouping

  1.3. Verify build:

- Run `pnpm build --filter=@agent-platform/database`

**Files Touched**:

- `packages/database/src/models/transcript.model.ts` -- NEW
- `packages/database/src/models/index.ts` -- add export line

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/database` succeeds with 0 errors
- [ ] `Transcript` model is importable from `@agent-platform/database/models`
- [ ] Schema has `tenantIsolationPlugin` applied (verified by reading plugin registration line)
- [ ] Schema has `encryptionPlugin` applied to `messages` field
- [ ] All 5 indexes defined including unique compound `(tenantId, sessionId, name)` and TTL on `expiresAt`
- [ ] `ITranscript` interface exported and matches HLD data model

**Test Strategy**:

- Unit: Model validation tests (required fields, defaults, schema version) in Phase 3

**Rollback**: Delete `transcript.model.ts`, remove export line from `index.ts`.

---

### Phase 2: Service Layer — TranscriptService

**Goal**: Implement the transcript service with all business logic for CRUD and export operations.

**Tasks**:

2.1. Create `apps/runtime/src/services/transcript-service.ts`:

- Import `Transcript`, `Session`, `Message` from `@agent-platform/database/models`
- Import `createLogger` from `@abl/compiler/platform`
- Import `zlib` (gzip/gunzip) from `node:zlib` via `util.promisify`
- Implement `create(tenantId, projectId, params, userId)`:
  - Query `Session.findOne({ _id: params.sessionId, tenantId, projectId })` -- 404 if not found
  - Query `Message.find({ sessionId, tenantId }).sort({ timestamp: 1 }).lean()`
  - Check message count against `TRANSCRIPT_MAX_MESSAGES` limit -- 409 if exceeded
  - Check idempotency: `Transcript.findOne({ tenantId, projectId, sessionId, name })` -- return existing if found
  - Compress messages: `gzip(JSON.stringify(messages))`
  - Create Transcript document with all fields
  - Log `transcript.created` at INFO level
  - Return `{ id, name, agentName, messageCount, createdAt }`
- Implement `get(tenantId, projectId, transcriptId)`:
  - `Transcript.findOne({ _id: transcriptId, tenantId, projectId, archivedAt: null }).lean()`
  - Decompress messages: `gunzip(transcript.messages)` then `JSON.parse`
  - Return full transcript with decompressed messages
- Implement `list(tenantId, projectId, params)`:
  - Build query filter from params (agentName, channel, dateFrom/dateTo, createdBy)
  - Always include `{ tenantId, projectId, archivedAt: null }`
  - `Transcript.find(filter).select('-messages').sort({ createdAt: -1 }).skip(offset).limit(limit).lean()`
  - `Transcript.countDocuments(filter)` for total
  - Return `{ total, transcripts }`
- Implement `delete(tenantId, projectId, transcriptId)`:
  - `Transcript.findOneAndUpdate({ _id: transcriptId, tenantId, projectId, archivedAt: null }, { archivedAt: new Date() })`
  - Return 404 if not found; return success if updated
  - Log `transcript.deleted` at INFO level
- Implement `export(tenantId, projectId, transcriptId, format)`:
  - Call `get()` to retrieve full transcript
  - Format as JSON (return object) or text (format with role labels, timestamps)
  - Return `{ content, contentType, filename }`

    2.2. Create compression utility functions:

- `compressMessages(messages: unknown[]): Promise<Buffer>` -- `gzip(JSON.stringify(messages))`
- `decompressMessages(buffer: Buffer): Promise<unknown[]>` -- `JSON.parse(gunzip(buffer))`
- `formatAsText(transcript): string` -- role labels, timestamps, header/footer

  2.3. Add transcript permission entries to RBAC:

- In `apps/runtime/src/middleware/rbac.ts`, add `transcript:read` to viewer, developer, admin roles in `PROJECT_ROLE_PERMISSIONS`
- Add `transcript:write` to developer and admin roles

**Files Touched**:

- `apps/runtime/src/services/transcript-service.ts` -- NEW
- `apps/runtime/src/middleware/rbac.ts` -- add permission entries

**Exit Criteria**:

- [ ] `TranscriptService` class exports `create`, `get`, `list`, `delete`, `export` methods
- [ ] All methods include `tenantId` and `projectId` in every MongoDB query
- [ ] Compression round-trip: `decompressMessages(compressMessages(input))` equals `input`
- [ ] `createLogger('transcripts')` used for all logging -- zero `console.` calls
- [ ] Error handling uses standard envelope `{ success: false, error: { code, message } }`
- [ ] `transcript:read` and `transcript:write` permissions added to role mappings
- [ ] `pnpm build --filter=runtime` succeeds

**Test Strategy**:

- Unit: Compression round-trip, name generation, text formatting (Phase 3)
- Integration: Service CRUD with real MongoDB (Phase 4)

**Rollback**: Delete `transcript-service.ts`, revert RBAC changes.

---

### Phase 3: API Layer — Routes + Unit Tests

**Goal**: Create project-scoped API routes with auth, validation, and OpenAPI registration. Write unit tests for service logic.

**Tasks**:

3.1. Create `apps/runtime/src/routes/project-transcripts.ts`:

- Import `createOpenAPIRouter` from `@agent-platform/openapi/express`
- Import `runtimeRegistry` from `../openapi/registry.js`
- Create router with `basePath: '/api/projects/:projectId/transcripts'`, tags: `['Transcripts']`
- Define Zod schemas for all request/response shapes (using `z.string().min(1)` for IDs)
- Register 5 routes (list, create, get, delete, export)
- Each route handler:
  - Calls `requireProjectPermission(req, res, 'transcript:read|write')`
  - Extracts `tenantId` from `req.tenantContext.tenantId`
  - Extracts `userId` from `req.tenantContext.userId`
  - Calls corresponding `TranscriptService` method
  - Returns standard response envelope
- IMPORTANT: Register `/export` route BEFORE `/:id` route (Express static-before-parameterized rule)

  3.2. Wire route into `apps/runtime/src/server.ts`:

- Add import: `import projectTranscriptsRouter from './routes/project-transcripts.js'`
- Add mount: `app.use('/api/projects/:projectId/transcripts', projectTranscriptsRouter)`
- Place alongside other project-scoped routes (after sessions, before diagnostics)

  3.3. Add deprecation headers to old route:

- In `apps/runtime/src/routes/transcripts.ts`, add `res.setHeader('Deprecation', 'true')` and `res.setHeader('Sunset', '<date>')` to all handlers

  3.4. Create `apps/runtime/src/__tests__/transcript-service.test.ts`:

- Unit tests for name auto-generation (UT-1, UT-2)
- Unit tests for compression round-trip (UT-7)
- Unit tests for text formatter output (UT-5, UT-6)
- Static analysis test for no console calls (UT-8)

**Files Touched**:

- `apps/runtime/src/routes/project-transcripts.ts` -- NEW
- `apps/runtime/src/server.ts` -- add import + mount
- `apps/runtime/src/routes/transcripts.ts` -- add deprecation headers
- `apps/runtime/src/__tests__/transcript-service.test.ts` -- NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] Route registered in `server.ts` at `/api/projects/:projectId/transcripts`
- [ ] All 5 endpoints use `requireProjectPermission` with correct permission strings
- [ ] Zod schemas use `z.string().min(1)` for ID fields (not `.cuid()` or `.uuid()`)
- [ ] Export route registered BEFORE `/:id` route (static before parameterized)
- [ ] Old `/api/v1/transcripts` route adds `Deprecation` header
- [ ] All unit tests pass: `pnpm test --filter=runtime -- --testPathPattern=transcript-service`
- [ ] Source code has zero `console.log`/`console.error` calls

**Test Strategy**:

- Unit: 8+ tests covering name generation, compression, text formatting, static analysis
- Integration: Auth/RBAC tests in Phase 4

**Rollback**: Revert `server.ts` changes, delete `project-transcripts.ts`.

---

### Phase 4: Integration Tests — Auth, Isolation, Service

**Goal**: Write integration and auth tests that verify isolation, permission enforcement, and service behavior with real MongoDB.

**Tasks**:

4.1. Create `apps/runtime/src/__tests__/transcripts-authz.test.ts`:

- Follow existing pattern from `sessions-authz.test.ts`
- Mock auth middleware to inject tenant context, mock openapi router
- Test all 5 endpoints for correct permission strings:
  - `GET /` requires `transcript:read`
  - `POST /` requires `transcript:write`
  - `GET /:id` requires `transcript:read`
  - `DELETE /:id` requires `transcript:write`
  - `GET /:id/export` requires `transcript:read`
- Test tenant OWNER bypass, project owner bypass, role-based access
- Test missing auth (401), insufficient permissions (403)

  4.2. Create integration test stubs for service:

- File: `apps/runtime/src/__tests__/integration/transcript-service.test.ts`
- Tests: INT-1 through INT-7 from test spec
- Uses MongoMemoryServer for real MongoDB
- Tests encryption round-trip, pagination, filtering, TTL, idempotency

**Files Touched**:

- `apps/runtime/src/__tests__/transcripts-authz.test.ts` -- NEW
- `apps/runtime/src/__tests__/integration/transcript-service.test.ts` -- NEW

**Exit Criteria**:

- [ ] Auth test verifies all 5 endpoints enforce correct permissions
- [ ] Auth test verifies 401 for missing auth, 403 for insufficient permissions
- [ ] Auth test follows `sessions-authz.test.ts` pattern (mock auth + openapi, real route logic)
- [ ] Integration tests pass with MongoMemoryServer
- [ ] `pnpm test --filter=runtime -- --testPathPattern=transcripts` passes all tests

**Test Strategy**:

- Integration: RBAC (authz), service CRUD with MongoDB
- E2E tests deferred to implementation phase (require full server setup)

**Rollback**: Delete test files (no production code changes in this phase).

---

### Phase 5: Studio Proxy + Hooks

**Goal**: Create Studio API proxy routes and SWR hooks for the frontend.

**Tasks**:

5.1. Create Studio proxy routes:

- `apps/studio/src/app/api/projects/[id]/transcripts/route.ts` (GET list, POST create)
- `apps/studio/src/app/api/projects/[id]/transcripts/[transcriptId]/route.ts` (GET detail, DELETE)
- `apps/studio/src/app/api/projects/[id]/transcripts/[transcriptId]/export/route.ts` (GET export)
- Each route: extract auth headers, proxy to runtime with `fetch(runtimeUrl + path, { headers })`
- Follow existing pattern from `apps/studio/src/app/api/projects/[id]/sessions/` routes

  5.2. Create SWR hooks:

- `apps/studio/src/hooks/useTranscripts.ts`:
  - `useTranscripts(projectId, filters)` -- SWR fetch from `/api/projects/${projectId}/transcripts`
  - Returns `{ transcripts, total, loading, error, mutate }`
- `apps/studio/src/hooks/useTranscriptDetail.ts`:
  - `useTranscriptDetail(projectId, transcriptId)` -- SWR fetch for single transcript
  - Returns `{ transcript, loading, error }`

    5.3. Create export download utility:

- Function `downloadTranscriptExport(projectId, transcriptId, format)` that fetches the export endpoint and triggers browser download

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/transcripts/route.ts` -- NEW
- `apps/studio/src/app/api/projects/[id]/transcripts/[transcriptId]/route.ts` -- NEW
- `apps/studio/src/app/api/projects/[id]/transcripts/[transcriptId]/export/route.ts` -- NEW
- `apps/studio/src/hooks/useTranscripts.ts` -- NEW
- `apps/studio/src/hooks/useTranscriptDetail.ts` -- NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Studio proxy routes forward auth headers to runtime
- [ ] SWR hooks return typed data matching runtime API response shapes
- [ ] Export download utility triggers browser file download

**Test Strategy**:

- Manual: Verify proxy routes return correct data via curl

**Rollback**: Delete new Studio files.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] `Transcript` model exported from `packages/database/src/models/index.ts`
- [ ] `project-transcripts.ts` router imported and mounted in `apps/runtime/src/server.ts`
- [ ] `transcript:read` and `transcript:write` added to `PROJECT_ROLE_PERMISSIONS` in `rbac.ts`
- [ ] Studio proxy routes created under `apps/studio/src/app/api/projects/[id]/transcripts/`
- [ ] SWR hooks importable from `apps/studio/src/hooks/`
- [ ] Old `transcripts.ts` route has deprecation headers (not removed)
- [ ] No Dockerfile changes needed (no new packages added)

---

## 5. Cross-Phase Concerns

### Database Migrations

No migration scripts. The `transcripts` collection is auto-created by Mongoose on first document insert. Indexes are created via `schema.index()` declarations.

### Feature Flags

None. The feature is additive (new routes alongside existing). The old route remains functional.

### Configuration Changes

| Variable                  | Default | Added In                             |
| ------------------------- | ------- | ------------------------------------ |
| `TRANSCRIPT_TTL_DAYS`     | `90`    | Phase 2 (service reads this env var) |
| `TRANSCRIPT_MAX_MESSAGES` | `2000`  | Phase 2 (service enforces limit)     |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 5 phases complete with exit criteria met
- [ ] `pnpm build` succeeds for runtime and database packages
- [ ] All unit tests pass (8+ tests)
- [ ] All auth tests pass (following sessions-authz pattern)
- [ ] All integration tests pass with MongoMemoryServer
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Source code has zero `console.log`/`console.error` calls
- [ ] All MongoDB queries include `tenantId` and `projectId`
- [ ] Zod schemas use `z.string().min(1)` for ID fields
- [ ] Feature spec updated to status ALPHA after implementation
- [ ] Testing matrix updated with actual coverage

---

## 7. Open Questions

1. **Encryption plugin on Buffer fields**: The `encryptionPlugin` in `message.model.ts` encrypts `content` (String type). Need to verify it works on Buffer fields. The `session-state.model.ts` uses `encryptionPlugin` on `stateData` (Buffer) -- confirm the plugin handles Buffer encryption correctly by reading its source before implementing.

2. **Studio proxy pattern**: Need to verify the exact proxy pattern used by existing Studio routes (e.g., `sessions/route.ts`). The proxy must forward auth headers, handle streaming for export, and pass query params correctly.

3. **Permission registration**: Need to verify whether `transcript:read` / `transcript:write` must be registered in the `ResourcePermission` or `ResourceType` model, or if adding them to `PROJECT_ROLE_PERMISSIONS` in `rbac.ts` is sufficient.

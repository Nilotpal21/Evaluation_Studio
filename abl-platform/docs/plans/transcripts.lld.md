# Transcripts -- Low-Level Design

**Status**: ALPHA
**Feature Spec**: [../features/transcripts.md](../features/transcripts.md)
**HLD**: [../specs/transcripts.hld.md](../specs/transcripts.hld.md)
**Testing Guide**: [../testing/transcripts.md](../testing/transcripts.md)
**Last Updated**: 2026-03-22

---

## Task T-1: TranscriptExport Type

### Files

- `apps/runtime/src/types/index.ts` -- TranscriptExport interface at line ~433

### Type Definition

```typescript
interface TranscriptExport {
  id: string;
  name: string;
  agentId: string;
  agentName: string;
  createdAt: Date;
  messages: SessionMessage[];
  traceEvents: TraceEvent[];
  finalState: AgentState;
}
```

### Related Types

- `SessionMessage`: `{ id, role, content, timestamp, traceIds, metadata? }`
- `TraceEvent`: Extended from `@agent-platform/shared-kernel` BaseTraceEvent with `TraceEventType`
- `AgentState`: Agent execution state record

---

## Task T-2: Transcript Route

### Files

- `apps/runtime/src/routes/transcripts.ts` -- 333 lines, 4 endpoints

### Constants

- `TRANSCRIPTS_DIR`: `path.resolve(process.cwd(), 'output/transcripts')`

### Helper Functions

**`ensureTranscriptsDir()`** -- Checks if `TRANSCRIPTS_DIR` exists via `access()`, creates via `mkdir({ recursive: true })` if not.

### Endpoints

**GET /** -- List transcripts

- Auth: `authMiddleware` (no RBAC)
- Reads all files via `readdir(TRANSCRIPTS_DIR)`
- Filters `.json` files only
- Parses each file via `Promise.all(files.map(async f => readFile + JSON.parse))`
- Returns: `{ success, total, transcripts: [{ id, name, agentId, agentName, messageCount, createdAt }] }`

**GET /:id** -- Get transcript by ID

- Auth: `authMiddleware`
- File path: `path.join(TRANSCRIPTS_DIR, '${id}.json')`
- Checks file existence via `access(filePath, constants.F_OK)`
- Returns 404 if file not found
- Returns: `{ success, transcript: TranscriptExport }`
- Note: No path traversal sanitization on `id` parameter

**POST /** -- Create transcript from session

- Auth: `authMiddleware`
- Body: `{ sessionId: string, name?: string }`
- Validates `sessionId` presence (returns 400 if missing)
- Fetches session via `getRuntimeExecutor().getSessionDetail(sessionId)` (returns 404 if null)
- Trace event fallback: if `detail.traceEvents.length === 0`, tries `getTraceStore().getEvents(sessionId)`
- Generates UUID via `crypto.randomUUID()`
- Auto-generates name: `${agentName}-${date}` when not provided
- Writes JSON file via `writeFile(filePath, JSON.stringify(transcript, null, 2))`
- Returns 201: `{ success, transcript: { id, name, filePath } }`
- Note: `filePath` in response exposes absolute server path

**DELETE /:id** -- Delete transcript

- Auth: `authMiddleware`
- Checks file existence via `access(filePath, constants.F_OK)`
- Removes file via `unlink(filePath)`
- Returns 404 if file not found
- Returns: `{ success, message: 'Transcript deleted' }`

---

## Task T-3: Server Wiring

### Files

- `apps/runtime/src/server.ts` -- import at line 18, mount at line 419

### Mount Point

```typescript
app.use('/api/v1/transcripts', transcriptsRouter);
```

Note: Uses `/api/v1/` prefix unlike project-scoped routes that use `/api/projects/:projectId/`.

---

## Task T-4: Unit Tests

### Files

- `apps/runtime/src/__tests__/transcript-routes.test.ts` -- 593 lines, ~20 test cases

### Test Architecture

- Mocks `node:fs/promises` with in-memory `Map<string, string>` filesystem
- Mocks `crypto.randomUUID()` with predictable sequential IDs
- Mocks `RuntimeExecutor.getSessionDetail()` with in-memory session map
- Mocks `TraceStore.getEvents()` to return empty array
- Extracts route handlers from Express router stack for direct invocation

### Test Suites

| Suite                  | Tests | Key Scenarios                                                                 |
| ---------------------- | ----- | ----------------------------------------------------------------------------- |
| GET / -- List          | 5     | Empty list, multiple transcripts, metadata, non-JSON filter, dir creation     |
| GET /:id -- Get by ID  | 2     | Existing transcript, 404 for missing                                          |
| POST / -- Create       | 5     | Valid session, auto-name, missing sessionId, missing session, async writeFile |
| DELETE /:id -- Delete  | 3     | Existing transcript, 404 for missing, async unlink                            |
| Full lifecycle         | 1     | Create -> get -> list -> delete -> confirm removed                            |
| Async I/O verification | 3     | No sync calls in source, concurrent reads, async handlers                     |

---

## Known Gaps

| ID      | Description                                                         | Severity |
| ------- | ------------------------------------------------------------------- | -------- |
| GAP-001 | No tenant/project isolation -- all users share transcript namespace | High     |
| GAP-002 | Local filesystem storage -- not distributed                         | High     |
| GAP-003 | No path traversal sanitization on `id` parameter                    | Medium   |
| GAP-004 | `filePath` in POST response exposes absolute server path            | Medium   |
| GAP-005 | No pagination for list endpoint                                     | Medium   |
| GAP-006 | No RBAC beyond basic auth                                           | Medium   |
| GAP-007 | No rate limiting                                                    | Low      |
| GAP-008 | File listing parses all JSON files per request                      | Low      |
| GAP-009 | No E2E tests with real Express server                               | High     |

---

## Dependencies

- `node:fs/promises` -- async file I/O (readdir, readFile, writeFile, unlink, mkdir, access)
- `node:path` -- path resolution and joining
- `crypto` -- randomUUID for transcript IDs
- `apps/runtime/src/services/runtime-executor.ts` -- `getRuntimeExecutor().getSessionDetail()`
- `apps/runtime/src/services/trace-store.ts` -- `getTraceStore().getEvents()`
- `apps/runtime/src/middleware/auth.ts` -- `authMiddleware`

---

## Exit Criteria

- All 4 CRUD endpoints function correctly with proper status codes
- File system operations use async `fs/promises` APIs exclusively
- Transcripts directory is auto-created on first use
- Session not found returns 404, missing sessionId returns 400
- All unit tests pass: `pnpm test --filter=runtime -- transcript-routes`

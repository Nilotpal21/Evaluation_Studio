# LLD + Implementation Plan: B03 Multimodality Support

**Feature**: B03 (File Upload Enhancement -- IDE-Grade + Multimodal)
**Feature Spec**: [docs/features/arch-multimodality.md](../features/arch-multimodality.md)
**HLD**: [docs/specs/arch-multimodality.hld.md](../specs/arch-multimodality.hld.md)
**Test Spec**: [docs/testing/arch-multimodality.md](../testing/arch-multimodality.md)
**Design Doc**: [docs/arch/research/2026-04-05-multimodality-design.md](../arch/research/2026-04-05-multimodality-design.md)
**Dev Plan Review**: [docs/arch/research/2026-04-05-multimodality-dev-plan-review.md](../arch/research/2026-04-05-multimodality-dev-plan-review.md)
**Oracle Decisions**: [docs/sdlc-logs/arch-multimodality/lld.log.md](../sdlc-logs/arch-multimodality/lld.log.md)
**Status**: DONE
**Last Updated**: 2026-04-05

---

## 1. Design Decisions

### 1.1 Decision Log

| #   | Decision                    | Choice                                               | Rationale                                                                                        | Oracle Ref |
| --- | --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| D1  | Data layer vs API first     | Data layer first                                     | SessionFileStore + types before upload endpoint (dependency order)                               | Q1         |
| D2  | Feature flag strategy       | Use existing `NEXT_PUBLIC_FEATURE_ARCH_AI`           | B03 is additive; no separate toggle needed                                                       | Q2         |
| D3  | `collect_file` coexistence  | Keep alongside proactive upload                      | Proactive upload auto-satisfies pending widget if type matches                                   | Q3         |
| D4  | GridFS threshold            | >4MB (not 8MB)                                       | Safe headroom below 16MB BSON limit when metadata included                                       | Q4         |
| D5  | Upload synchronicity        | Synchronous with per-type timeouts                   | 5-30s timeouts per type; async adds complexity without benefit at this scale                     | Q5         |
| D6  | File store location         | `packages/arch-ai/src/session/file-store-service.ts` | Colocated with session logic, not a separate directory                                           | Q6/Q10     |
| D7  | `normalizeContent` location | `packages/arch-ai/src/types/content-blocks.ts`       | Shared between server and client                                                                 | Q7         |
| D8  | Image resize worker         | Dedicated worker file, not inline Blob URL           | Better debugging, caching, and tree-shaking                                                      | Q8         |
| D9  | File preamble injection     | Append to system prompt string                       | Outside sliding window; simpler than separate message injection                                  | Q9         |
| D10 | Shared multimodal builder   | Extract `buildMultimodalMessages()` helper           | Used by both ONBOARDING and IN_PROJECT route paths                                               | Q11        |
| D11 | Mongoose Mixed rollback     | `normalizeContent()` text extraction + schema revert | Backward-compatible degradation                                                                  | Q12        |
| D12 | Logging                     | TraceEvent per upload from day one                   | Platform invariant #4 (traceability)                                                             | Q13        |
| D13 | Phase 4 smart routing       | Separate ticket (not core B03)                       | Core B03 = Phases 0-3; smart routing follows                                                     | Q14        |
| D14 | `blobId` format             | `crypto.randomUUID()` (v4)                           | Consistent with existing codebase UUID usage. Ordering by `createdAt` index, not UUID timestamp. | HLD        |

### 1.2 Key Interfaces and Types

```typescript
// packages/arch-ai/src/types/content-blocks.ts (NEW)

type ArchContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image_ref';
      blobId: string;
      name: string;
      mediaType: string;
      width: number;
      height: number;
      tokenCost: number;
      status?: 'active' | 'failed';
    }
  | {
      type: 'file_ref';
      blobId: string;
      name: string;
      mediaType: string;
      summary?: string;
      tokenCost: number;
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

function normalizeContent(content: string | ArchContentBlock[] | undefined): string;
function extractContentBlocks(content: string | ArchContentBlock[]): ArchContentBlock[];
```

```typescript
// packages/arch-ai/src/session/file-store-service.ts (NEW)

interface SessionFile {
  _id: string; // blobId (crypto.randomUUID v4)
  sessionId: string;
  tenantId: string;
  name: string;
  mediaType: string;
  size: number;
  hash: string; // SHA-256
  content: Buffer; // GridFS ref for >4MB
  metadata: {
    width?: number;
    height?: number;
    pageCount?: number;
    lineCount?: number;
    language?: string;
    endpointCount?: number;
    columns?: string[];
    rowCount?: number;
    tokenEstimate: number;
  };
  phase: string;
  status: 'active' | 'excluded' | 'evicted' | 'deleted' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

// SessionContext = { tenantId: string; userId: string } — matches session-service.ts pattern.
// If not already shared, extract to packages/arch-ai/src/types/context.ts.
interface SessionContext {
  tenantId: string;
  userId: string;
}

interface FileStoreService {
  store(ctx: SessionContext, sessionId: string, file: UploadPayload): Promise<SessionFile>;
  getByBlobId(ctx: SessionContext, sessionId: string, blobId: string): Promise<SessionFile | null>;
  getActiveFiles(ctx: SessionContext, sessionId: string): Promise<SessionFile[]>;
  updateStatus(
    ctx: SessionContext,
    sessionId: string,
    blobId: string,
    status: SessionFile['status'],
  ): Promise<void>;
}

// Constructor + factory (DI-friendly):
class FileStoreService {
  constructor(private readonly model: Model<ISessionFile>) {}
  // ... implements interface above
}

function createFileStoreService(model: Model<ISessionFile>): FileStoreService;
```

> **User isolation note:** User isolation is enforced at the route layer via session ownership check (`session.userId === auth.userId`). FileStoreService queries use `sessionId` + `tenantId` for session isolation. Defense-in-depth: the session already gates user access.

```typescript
// Provider content block format (executor output, not persisted)
// Define in types/content-blocks.ts alongside ArchContentBlock -- used by both resolver and route handler.

type ProviderContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } // Anthropic
  | { type: 'image_url'; image_url: { url: string } } // OpenAI
  | { inlineData: { mimeType: string; data: string } }; // Google
```

### 1.3 Module Boundaries

| Module                                                    | Responsibility                                          | Exports                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/arch-ai/src/types/content-blocks.ts`            | Content block types + normalization                     | `ArchContentBlock`, `normalizeContent`, `extractContentBlocks`, `isArchContentBlock` |
| `packages/arch-ai/src/session/file-store-service.ts`      | SessionFileStore CRUD, dedup, metadata extraction       | `FileStoreService`, `SessionFile`, `createFileStoreService`                          |
| `packages/arch-ai/src/executor/content-block-resolver.ts` | ArchContentBlock[] to ProviderContentBlock[] conversion | `resolveContentBlocks`, `buildFilePreamble`, `buildMultimodalMessages`               |
| `packages/database/src/models/session-file.model.ts`      | Mongoose model for SessionFileStore                     | `SessionFileModel`                                                                   |
| `apps/studio/src/app/api/arch-ai/files/route.ts`          | Upload endpoint                                         | `POST` handler                                                                       |
| `apps/studio/src/lib/arch/upload-files.ts`                | Client-side upload orchestrator                         | `uploadFiles`, `UploadProgress`                                                      |
| `apps/studio/src/workers/image-resize.worker.ts`          | Web Worker for OffscreenCanvas resize + base64          | `resize`, `encode` messages                                                          |

---

## 2. File-Level Change Map

### 2.1 New Files

| File                                                               | Purpose                                                                      | Risk                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/arch-ai/src/types/content-blocks.ts`                     | ArchContentBlock union type, `normalizeContent()`, `extractContentBlocks()`  | LOW -- pure types + helper                        |
| `packages/arch-ai/src/session/file-store-service.ts`               | FileStoreService: store, dedup, metadata extraction, status transitions      | MEDIUM -- MongoDB operations                      |
| `packages/arch-ai/src/executor/content-block-resolver.ts`          | `resolveContentBlocks()`, `buildFilePreamble()`, `buildMultimodalMessages()` | HIGH -- provider format conversion, vision gating |
| `packages/database/src/models/session-file.model.ts`               | Mongoose model + indexes for SessionFileStore collection                     | LOW -- schema definition                          |
| `apps/studio/src/app/api/arch-ai/files/route.ts`                   | `POST /api/arch-ai/files` upload endpoint                                    | MEDIUM -- validation, auth, processing            |
| `apps/studio/src/lib/arch/upload-files.ts`                         | Client upload orchestrator: `uploadFiles()` with per-file progress           | LOW -- client HTTP                                |
| `apps/studio/src/workers/image-resize.worker.ts`                   | Web Worker: OffscreenCanvas resize + base64 encoding                         | MEDIUM -- Worker API, canvas                      |
| `apps/studio/src/components/arch-v3/chat/ContentBlockRenderer.tsx` | Per-block renderer (text, image_ref thumbnail, file_ref badge)               | LOW -- UI only                                    |
| `apps/studio/src/components/arch-v3/chat/ImageLightbox.tsx`        | Full-resolution image viewer modal                                           | LOW -- UI only                                    |
| `apps/studio/src/components/arch-v3/panels/TokenBudgetGauge.tsx`   | Token budget bar (used/total, color coding)                                  | LOW -- UI only                                    |
| `apps/studio/src/components/arch-v3/panels/FileContextMenu.tsx`    | Per-type right-click context menu                                            | LOW -- UI only                                    |

### 2.2 Modified Files

| File                                                                     | Change                                                                                                  | Risk                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `packages/arch-ai/src/types/session.ts:29`                               | `content: string` to `content: string \| ArchContentBlock[]`                                            | HIGH -- 10 consumers (migration matrix)     |
| `packages/arch-ai/src/types/sse-events.ts:96-112`                        | Add 3 new SSE schemas to `ArchSSEEventSchema` discriminated union                                       | HIGH -- parser drops unknown types silently |
| `packages/arch-ai/src/executor/specialist-executor.ts:46`                | `messages[].content: string` to `string \| ProviderContentBlock[]`                                      | HIGH -- LLM interface contract              |
| `packages/arch-ai/src/executor/multi-turn-executor.ts:27`                | `MultiTurnMessage.content: string` to `string \| ProviderContentBlock[]`                                | MEDIUM -- interface change                  |
| `packages/database/src/models/arch-session.model.ts:75`                  | `content: { type: String }` to `content: { type: Schema.Types.Mixed }`                                  | HIGH -- removes Mongoose strict validation  |
| `apps/studio/src/hooks/useArchChat.ts:37-44`                             | Add `rawContent?: ArchContentBlock[]` to `ChatMessage` interface                                        | MEDIUM -- new optional field                |
| `apps/studio/src/hooks/useArchChat.ts:125-141`                           | `loadSession`: apply `normalizeContent()`, extract `rawContent`                                         | HIGH -- session resume regression vector    |
| `apps/studio/src/hooks/useArchChat.ts:279-589`                           | Add `file_processed`, `file_error`, `file_context_change` cases to SSE switch                           | MEDIUM -- new event handlers                |
| `apps/studio/src/hooks/useArchChat.ts:286-302`                           | `text_delta` guard: add `!last.rawContent` to prevent file message clobber                              | HIGH -- clobber bug regression              |
| `apps/studio/src/app/api/arch-ai/message/route.ts:~1163`                 | Build `ArchContentBlock[]` from `msg.text` + resolved `fileRefs` (IN_PROJECT `processInProjectMessage`) | HIGH -- persistence path                    |
| `apps/studio/src/app/api/arch-ai/message/route.ts:~1233`                 | IN_PROJECT `llmMessages` builder: support `ProviderContentBlock[]` in content field                     | HIGH -- LLM message format                  |
| `apps/studio/src/app/api/arch-ai/message/route.ts:~1364`                 | ONBOARDING `processMessage`: same content block + fileRefs change as line ~1163                         | HIGH -- dual route parity                   |
| `apps/studio/src/app/api/arch-ai/message/route.ts:60-112`                | `VercelLLMStreamClient.streamChat`: pass provider content blocks through                                | HIGH -- Vercel AI SDK format                |
| `apps/studio/src/app/arch/page.tsx:198-223`                              | `handleChatBarSend`: replace `encodeFilesForRequest` with `uploadFiles()` flow                          | MEDIUM -- encoding flow change              |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx:131-141`     | `handleSendWithFiles`: same upload flow change + add `onDragOver`/`onDrop`                              | MEDIUM -- overlay stability                 |
| `apps/studio/src/components/chat/ChatInputBar.tsx`                       | Add `onPaste` handler for clipboard screenshots, drag-drop zone, progress                               | MEDIUM -- input component extensions        |
| `apps/studio/src/store/arch-ai-store.ts`                                 | Extend `FilePanelFile` with `fileType: 'upload'` + `upload` metadata                                    | LOW -- additive field                       |
| `apps/studio/src/components/arch-v3/panels/IDEPanel.tsx`                 | Add UPLOADS group, token gauge, context menu integration                                                | MEDIUM -- file tree extension               |
| `apps/studio/src/components/arch-v3/specification/SpecificationCard.tsx` | Add "Attached Files" collapsible section                                                                | LOW -- additive UI                          |
| `docs/arch/contracts/sse-protocol.md`                                    | Add 3 B03 events, remove dead spec types, add `activity`                                                | LOW -- documentation                        |

---

## 3. Implementation Phases

### Phase 0: Prerequisites

**Goal:** Align SSE schema, prepare StoredMessage for content blocks, and fix drag-drop navigation -- zero feature behavior change.

#### Task 0.1: SSE Contract/Schema/Parser Alignment

**Files:**

- `docs/arch/contracts/sse-protocol.md` -- remove dead types (`step_start`, `step_complete`, `status_update`), add `activity` (B05), add `file_processed`, `file_error`, `file_context_change` (B03). New total: 16 types.
- `packages/arch-ai/src/types/sse-events.ts` -- add 3 new Zod schemas:

```typescript
// Add to sse-events.ts before ArchSSEEventSchema

export const FileProcessedEventSchema = z.object({
  type: z.literal('file_processed'),
  blobId: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
  tokenCost: z.number(),
  metadata: z.record(z.unknown()),
  smartAction: z
    .object({
      type: z.string(),
      prompt: z.string(),
      actions: z.array(z.object({ label: z.string(), action: z.string() })),
    })
    .optional(),
});

export const FileErrorEventSchema = z.object({
  type: z.literal('file_error'),
  fileName: z.string(),
  error: z.object({
    code: z.enum([
      'corrupt',
      'parse_failed',
      'type_mismatch',
      'too_large',
      'decode_failed',
      'invalid_spec',
      'timeout',
      'session_full',
    ]),
    message: z.string(),
  }),
  recovery: z.array(z.string()),
});

export const FileContextChangeEventSchema = z.object({
  type: z.literal('file_context_change'),
  blobId: z.string(),
  change: z.enum(['evicted', 'included', 'excluded', 'deleted', 'failed']),
  contextBudget: z
    .object({
      used: z.number(),
      total: z.number(),
    })
    .optional(),
});
```

- Add all 3 to `ArchSSEEventSchema` discriminated union array (line 96)
- `apps/studio/src/hooks/useArchChat.ts:279-589` -- add `case 'file_processed':`, `case 'file_error':`, `case 'file_context_change':` (initially log-only, no state change)

**Exit criteria:**

- `pnpm build --filter=@agent-platform/arch-ai` succeeds
- `pnpm build --filter=studio` succeeds
- Regression tests #1-4 pass: emit each new event type from test, parser accepts; unknown type silently dropped

**Commit:** `[ABLP-xxx] refactor(studio): align SSE schema -- add B03 file events, remove dead spec types`

#### Task 0.2: StoredMessage Content Type Migration (Zero-Feature)

> **Package limit note:** If package count becomes an issue (3 packages at limit), split: (a) arch-ai type changes as standalone commit, (b) studio + database changes as second commit.

**Files:**

- Create `packages/arch-ai/src/types/content-blocks.ts` -- `ArchContentBlock` union type, `normalizeContent()`, `extractContentBlocks()`, `isArchContentBlock()` type guard
- `packages/arch-ai/src/types/session.ts:29` -- change `content: string` to `content: string | ArchContentBlock[]`
- `packages/database/src/models/arch-session.model.ts:75` -- change `content: { type: String, required: true }` to `content: { type: Schema.Types.Mixed, required: true }`
- `apps/studio/src/hooks/useArchChat.ts:37-44` -- add `rawContent?: ArchContentBlock[]` to `ChatMessage`
- `apps/studio/src/hooks/useArchChat.ts:125-141` -- in `loadSession` restore loop, change `content: m.content` to `content: normalizeContent(m.content)` and add `rawContent: Array.isArray(m.content) ? m.content : undefined`
- `packages/arch-ai/src/executor/specialist-executor.ts:46` -- change `content: string` to `content: string | ProviderContentBlock[]` in `LLMStreamClient.streamChat` messages parameter
- `packages/arch-ai/src/executor/multi-turn-executor.ts:27` -- change `MultiTurnMessage.content: string` to `string | ProviderContentBlock[]`
- `apps/studio/src/app/api/arch-ai/message/route.ts:~1233` -- in IN_PROJECT llmMessages builder, apply `normalizeContent()` to `m.content` for backward-compatible string extraction
- `apps/studio/src/app/api/arch-ai/message/route.ts:60-112` -- in `VercelLLMStreamClient.streamChat`, handle `content` being `string | ProviderContentBlock[]`: if string, pass through; if array, convert to Vercel AI SDK format

**Content migration matrix verification (all 10 consumers):**

| #   | Consumer                 | File:Line                   | Change                       | Verified? |
| --- | ------------------------ | --------------------------- | ---------------------------- | --------- |
| 1   | TypeScript type          | `session.ts:29`             | Union type                   |           |
| 2   | Mongoose schema          | `arch-session.model.ts:75`  | `Schema.Types.Mixed`         |           |
| 3   | Route write (IN_PROJECT) | `route.ts:~1163`            | No change yet (still string) |           |
| 4   | Route write (ONBOARDING) | `route.ts:~1364`            | No change yet (still string) |           |
| 5   | LLM builder (IN_PROJECT) | `route.ts:~1233`            | `normalizeContent()`         |           |
| 6   | Client message type      | `useArchChat.ts:37`         | `rawContent` field           |           |
| 7   | Session restore          | `useArchChat.ts:125`        | `normalizeContent()`         |           |
| 8   | Executor interface       | `specialist-executor.ts:46` | Union type                   |           |
| 9   | Multi-turn executor      | `multi-turn-executor.ts:27` | Union type                   |           |
| 10  | Chat renderer            | No change yet               | Phase 3 work                 |           |

**Exit criteria:**

- `pnpm build --filter=@agent-platform/arch-ai` succeeds
- `pnpm build --filter=@agent-platform/database` succeeds
- `pnpm build --filter=studio` succeeds
- Regression tests #5-6 pass: create session with `content: string`, resume renders correctly; create session with `content: ArchContentBlock[]`, `normalizeContent()` returns text string
- Zero multimodal behavior at this point -- existing text-only flow unchanged

**Commit:** `[ABLP-xxx] refactor(studio): prepare StoredMessage for content blocks -- normalizeContent at all read sites`

#### Task 0.3: ArchOverlay Drag-Drop Navigation Prevention

**Files:**

- `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` -- add `onDragOver` and `onDrop` `preventDefault` handlers to the overlay container `<div>`:

```typescript
// On the overlay wrapper div
onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}
```

**Exit criteria:**

- Regression test #7 passes: drop file on ArchOverlay, browser does NOT navigate away
- `pnpm build --filter=studio` succeeds

**Commit:** `[ABLP-xxx] fix(studio): prevent file-drop navigation in ArchOverlay`

#### Task 0.4: Research Doc Authoritative Pointer

**Files:**

- `docs/arch/research/2026-04-05-multimodality-research.md` -- add top-level note: "This is a research document. The approved design is in `2026-04-05-multimodality-design.md`. Where they conflict, the design doc is authoritative."

**Exit criteria:**

- Research doc has prominent authoritative-design pointer at top

**Commit:** `[ABLP-xxx] docs(studio): add authoritative-design pointer to multimodality research doc`

#### Phase 0 Exit Criteria Summary

- `ArchSSEEventSchema` validates all 16 event types (13 existing + 3 new B03)
- `normalizeContent('text')` returns `'text'`; `normalizeContent([{ type: 'text', text: 'hello' }])` returns `'hello'`
- Existing text-only sessions load and render identically (no regression)
- File drop on ArchOverlay blocked (no browser navigation)
- `pnpm build` succeeds across all affected packages
- Regression tests #1-8 from dev plan review pass

#### Phase 0 Rollback Strategy

All changes are zero-feature. Revert each commit individually -- no data migration to undo, no feature flags to toggle.

---

### Phase 1: Upload Endpoint + Content Blocks (Text Files Only)

**Goal:** Upload text files via `POST /api/arch-ai/files`, persist messages with `ArchContentBlock[]`, inject files into LLM context via system prompt preamble, and survive session resume without `[object Object]`.

#### Task 1.1: SessionFile Mongoose Model + Indexes

**Files:**

- Create `packages/database/src/models/session-file.model.ts`:
  - Schema fields: `_id` (String, `crypto.randomUUID()` v4), `sessionId` (String, required), `tenantId` (String, required), `name`, `mediaType`, `size`, `hash`, `content` (Buffer), `metadata` (Mixed), `phase`, `status` (enum), `createdAt`, `updatedAt`
  - Indexes: `{ sessionId: 1, status: 1 }`, `{ sessionId: 1, hash: 1 }` (unique), `{ tenantId: 1, sessionId: 1 }`, TTL index on `createdAt` (30 days) for orphaned file cleanup
- Export from `packages/database/src/models/index.ts`

**Exit criteria:**

- `pnpm build --filter=@agent-platform/database` succeeds
- Model importable and schema validates test document

**Commit:** `[ABLP-xxx] feat(database): add SessionFile model + indexes for B03`

#### Task 1.2: FileStoreService (CRUD + Dedup + Metadata)

**Files:**

- Create `packages/arch-ai/src/session/file-store-service.ts`:
  - `store()`: validate, compute SHA-256, dedup check (`{ sessionId, hash }`), extract metadata per type with timeouts (image 10s, CSV 10s, code 5s, DOCX 15s, OpenAPI 15s, PDF 30s), compute `tokenEstimate`, persist to SessionFileModel. Name collision check: if a file with the same `name` but different `hash` exists in the same session, return `{ collision: true, existingBlobId, newHash }`. Client shows DuplicateFileDialog: Replace / Keep Both (auto-rename with `-1` suffix) / Cancel.
  - `getByBlobId()`: query `{ _id: blobId, sessionId, tenantId }` -- tenant isolation at query level
  - `getActiveFiles()`: query `{ sessionId, tenantId, status: 'active' }`
  - `updateStatus(ctx, sessionId, blobId, status)`: update status with query `{ _id: blobId, sessionId, tenantId: ctx.tenantId }` (tenant + session isolation)
  - Magic byte verification: PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), GIF (`47 49 46 38`), PDF (`25 50 44 46`)
  - Token estimation: text files = `characters / 4`; images = `(width * height) / 750`; PDF = `pageCount * 1500`
  - Use `createLogger('arch-ai:file-store')` from `@abl/compiler/platform`. Log structured events: `{ event: 'file_upload', blobId, sessionId, tenantId, size, mediaType, processingTime, status: 'success'|'error' }` (platform invariant #4 -- traceability)
  - SVG sanitization with DOMPurify on server side
  - EXIF stripping for images
  - Define error types in `packages/arch-ai/src/types/errors.ts`: `FileNotFoundError`, `FileTooLargeError`, `FileCorruptError`, `SessionFileQuotaError` -- following existing pattern (extends Error, sets `this.name`)

**Exit criteria:**

- `pnpm build --filter=@agent-platform/arch-ai` succeeds
- Unit test: store file, retrieve by blobId, dedup returns same blobId for same hash+session, different blobId for different session
- Unit test: magic byte mismatch rejected
- Integration test INT-1 scenario passes

**Commit:** `[ABLP-xxx] feat(arch-ai): add FileStoreService -- CRUD, SHA-256 dedup, metadata extraction`

#### Task 1.3: Upload Endpoint (`POST /api/arch-ai/files`)

**Files:**

- Create `apps/studio/src/app/api/arch-ai/files/route.ts`:
  - Auth via Studio Next.js App Router pattern: `import { requireAuth, isAuthError } from '@/lib/auth'` (NOT Express `createUnifiedAuthMiddleware` -- this is a Next.js route handler)
  - Zod request validation:
    ```typescript
    const UploadRequestSchema = z.object({
      sessionId: z.string().min(1),
      file: z.object({
        name: z.string().min(1),
        type: z.string().min(1),
        size: z
          .number()
          .positive()
          .max(10 * 1024 * 1024),
        content: z.string().min(1),
      }),
    });
    ```
  - Request body: `{ sessionId: string, file: { name: string, type: string, size: number, content: string /* base64 */ } }`
  - Session ownership check: `ArchSession.findOne({ _id: sessionId, tenantId: auth.tenantId })` then verify `session.userId === auth.userId`, returning 404 if either fails
  - Validate: session exists, session belongs to user+tenant, file size <= 10MB, session total <= 50MB, supported MIME type, non-empty
  - Call `fileStoreService.store()` for processing
  - Response envelope: `{ success: true, data: { blobId: string, metadata: SessionFile['metadata'], tokenCost: number } }`
  - Error envelope: `{ success: false, error: { code: string, message: string } }`
  - Error responses: 400 (validation), 413 (too large), 422 (corrupt/unprocessable)
  - Emit `file_processed` SSE event via session channel (or return in response -- endpoint is synchronous per Q5)

**Exit criteria:**

- `pnpm build --filter=studio` succeeds
- E2E test E2E-1 scenario: POST file, receive blobId, re-upload same content returns same blobId
- Regression test #9 passes

**Commit:** `[ABLP-xxx] feat(studio): add POST /api/arch-ai/files upload endpoint`

#### Task 1.4: Content Block Resolution + File Preamble Builder

**Files:**

- Create `packages/arch-ai/src/executor/content-block-resolver.ts`:
  - `resolveContentBlocks(blocks: ArchContentBlock[], fileStore: FileStoreService, ctx: SessionContext, sessionId: string, capabilities: ModelCapabilities)`: converts `ArchContentBlock[]` to `ProviderContentBlock[]`
    - `text` blocks: pass through
    - `file_ref` blocks: resolve blobId -> text content, inline as `[File: {name}]\n{content}\n[/File]`, truncate at 50K chars
    - `image_ref` blocks: Phase 2 (skip for now, return text fallback)
    - `tool_use`/`tool_result`: pass through unchanged
  - `buildFilePreamble(activeFiles: SessionFile[], capabilities: ModelCapabilities)`: generates preamble string. Implement eviction logic: (a) sum token costs of all active files, (b) compare against `contextBudget * 0.5` (50% of model context for files), (c) if exceeded, evict in order: images oldest-first, then text files oldest-first, (d) call `updateStatus(ctx, sessionId, blobId, 'evicted')`, (e) emit `file_context_change` SSE events with `change: 'evicted'`. Return evicted file list for client notification.
    ```
    [Session Files]
    [File: api-spec.yaml (YAML, 2.4KB)]
    {content}
    [/File]
    [/Session Files]
    ```
  - `buildMultimodalMessages(storedMessages: StoredMessage[], fileStore: FileStoreService, ctx: SessionContext, sessionId: string, capabilities: ModelCapabilities)`: builds `Array<{ role: string; content: string | ProviderContentBlock[] }>` from stored messages, resolving content blocks

**Exit criteria:**

- `pnpm build --filter=@agent-platform/arch-ai` succeeds
- Unit test: text block passes through, file_ref resolves to inline text, image_ref returns text fallback
- Unit test: preamble builder includes active files, excludes excluded/deleted/evicted
- Integration test INT-2 passes (content block resolution produces correct formats)

**Commit:** `[ABLP-xxx] feat(arch-ai): add content block resolver + file preamble builder`

#### Task 1.5: Wire Content Blocks Through Route Handler

**Files:**

- `apps/studio/src/app/api/arch-ai/message/route.ts`:
  - **Line ~1163 (IN_PROJECT `processInProjectMessage`)**: When `msg.fileRefs` exists, resolve blobIds from `fileStoreService.getByBlobId()`, build `ArchContentBlock[]` (`[{ type: 'text', text: msg.text }, ...fileRefBlocks]`), persist with `content: archContentBlocks` instead of `content: msg.text`
  - **Line ~1364 (ONBOARDING `processMessage`)**: Same change -- build content blocks from `msg.text` + `msg.fileRefs`
  - **Line ~1233 (IN_PROJECT llmMessages builder)**: Replace direct `m.content` usage with `buildMultimodalMessages()` call that resolves content blocks via executor
  - **System prompt preamble**: Before building `llmMessages`, call `buildFilePreamble(activeFiles, capabilities)` and prepend to system prompt string
  - **Add `fileRefs` to message request Zod validation**: `fileRefs: z.array(z.object({ blobId: z.string().min(1) })).optional()`
  - **Both route paths** must be updated (dev plan review rule #11)

**Exit criteria:**

- `pnpm build --filter=studio` succeeds
- E2E test E2E-2: upload file, send message with fileRef, LLM response references file content
- E2E test E2E-3: session resume with content blocks -- no `[object Object]`
- E2E test E2E-5: file persists beyond 8-message sliding window via preamble
- E2E test E2E-6: full Interview flow with file upload -- zero regression to widgets/gates
- Regression tests #10-20 pass (content persistence, session resume, sliding window, widget reconstruction, gate reconstruction, text_delta guard, processing timeout)

**Commit:** `[ABLP-xxx] feat(studio): wire content blocks + file preamble through route handler`

#### Task 1.6: Client Upload Flow + `fileRefs` in `send()`

**Files:**

- Create `apps/studio/src/lib/arch/upload-files.ts`:
  - `uploadFiles(sessionId: string, files: File[], onProgress: (fileIndex: number, progress: number) => void)`: POST each file to `/api/arch-ai/files`, return `Array<{ blobId: string, metadata: SessionFile['metadata'], tokenCost: number }>`
- `apps/studio/src/hooks/useArchChat.ts`:
  - Modify `postMessage` body (line ~253): add `fileRefs` field when blobIds present
  - `send()` signature: accept `fileRefs?: Array<{ blobId: string }>` alongside text
- `apps/studio/src/app/arch/page.tsx:198-223`:
  - `handleChatBarSend()`: replace `encodeFilesForRequest(pending)` + `send(text, encodedFiles)` with `await uploadFiles(sessionId, files, onProgress)` then `send(text, undefined, { fileRefs: blobIds.map(b => ({ blobId: b.blobId })) })`
- `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx:131-141`:
  - `handleSendWithFiles()`: same replacement as above

**Exit criteria:**

- `pnpm build --filter=studio` succeeds
- Regression test #8 passes: send message with files from ChatInputBar, `useArchChat.send()` receives fileRefs
- Regression test #16 passes: send message in overlay, multi-turn completes
- Both surfaces (page + overlay) use upload-then-reference flow

**Commit:** `[ABLP-xxx] feat(studio): client upload flow -- replace encodeFilesForRequest with upload-then-ref`

#### Phase 1 Test Strategy

- **Unit tests**: `normalizeContent()` (8 cases from UNIT-1), token estimation, magic byte verification (UNIT-4), file validation
- **Integration tests**: INT-1 (SessionFileStore CRUD + dedup), INT-4 (file preamble injection — steps 8-10 validate eviction ordering: images first, then text, oldest first), INT-5 (content block round-trip)
- **E2E tests**: E2E-1 (upload + blobId), E2E-2 (fileRef + LLM), E2E-3 (session resume), E2E-5 (preamble persists), E2E-6 (full flow)

#### Phase 1 Exit Criteria Summary

- Upload same-named file with different content -> collision detected, client prompted
- Upload files exceeding 50% of context budget -> oldest image evicted first, file_context_change emitted
- Upload a YAML file via `/api/arch-ai/files` -- blobId returned with metadata and tokenEstimate
- Send message with `fileRefs: [{ blobId }]` -- `StoredMessage.content` is `ArchContentBlock[]`
- LLM response references file content (proving file was injected into context)
- Session resume renders file-carrying messages correctly (no `[object Object]`)
- After 10+ messages, file still in LLM context via system prompt preamble (not sliding window)
- Upload JPEG with EXIF metadata -> stored file has EXIF stripped (verify via metadata inspection)
- Full Interview flow (message -> widget -> Blueprint transition) works with file uploads
- IN_PROJECT overlay sends files successfully
- `pnpm build` succeeds across `arch-ai`, `database`, `studio`
- Regression tests #9-20 from dev plan review pass

#### Phase 1 Rollback Strategy

1. Revert route changes (content block building, preamble injection)
2. Revert client upload flow (restore `encodeFilesForRequest`)
3. `normalizeContent()` degrades gracefully -- content blocks become text strings
4. SessionFileStore collection remains (orphaned data, no impact)
5. Phase 0 type changes are backward-compatible (union accepts strings)

---

### Phase 2: Image Upload + Vision

**Goal:** Support image paste/drag-drop, resize in Web Worker, gate on model vision capability, convert to provider-specific formats, and gracefully degrade for non-vision models.

#### Task 2.1: Web Worker Image Resize + Base64 Encoding

**Files:**

- Create `apps/studio/src/workers/image-resize.worker.ts`:
  - Message handler for `{ type: 'resize', imageData: ArrayBuffer, maxDim: number, targetFormat: string }`
  - Use `OffscreenCanvas` to resize images > 1568px on longest edge
  - Return `{ type: 'resized', base64: string, width: number, height: number }`
  - Handle canvas errors gracefully (return original if resize fails)
- Update `apps/studio/src/lib/arch/upload-files.ts`:
  - Before upload, check if image exceeds 1568px
  - If so, send to Worker for resize, await result
  - Base64 encoding also in Worker (not main thread)

**Exit criteria:**

- `pnpm build --filter=studio` succeeds
- Regression test #21: paste 12000x8000 image, resize completes in Worker, no main thread freeze
- Regression test #28: drop 5 images simultaneously, per-file progress, no freeze
- Unit test: Worker returns resized dimensions <= 1568px on longest edge

**Commit:** `[ABLP-xxx] feat(studio): add Web Worker image resize + base64 encoding`

#### Task 2.2: Provider-Aware Vision Gating + Format Conversion

**Files:**

- Update `packages/arch-ai/src/executor/content-block-resolver.ts`:
  - For `image_ref` blocks, call `getModelCapabilities(activeModelId)` from `packages/compiler/src/platform/llm/model-capabilities.ts`
  - Import `getModelCapabilities` via deep path: `import { getModelCapabilities } from '@abl/compiler/platform/llm/model-capabilities.js'` -- avoids collision with `ModelCapabilities` from `model-registry`. Do NOT add to platform barrel export. **Verify** the deep path resolves correctly in the `arch-ai` package build.
  - If `supportsVision: true`: resolve blobId -> base64 from SessionFileStore, convert to provider format:
    - Anthropic: `{ type: 'image', source: { type: 'base64', media_type, data } }`
    - OpenAI: `{ type: 'image_url', image_url: { url: 'data:{mime};base64,{data}' } }`
    - Google: `{ inlineData: { mimeType, data } }`
  - If `supportsVision: false`: text fallback using i18n key `files.vision_unavailable` -- renders as `[Image attached: {name}, {w}x{h}px, {type} -- vision analysis unavailable with current model]`. On the server side (content-block-resolver), use the English string directly since this is LLM context, not user-facing UI.
  - If `image_ref.status === 'failed'`: skip block entirely (auto-skip)
- Update `apps/studio/src/app/api/arch-ai/message/route.ts:60-112`:
  - `VercelLLMStreamClient.streamChat`: when `m.content` is an array (ProviderContentBlock[]), convert to Vercel AI SDK format:
    - Image blocks: `{ type: 'image', image: 'data:{mime};base64,{data}' }` (Vercel AI SDK image format)
    - Text blocks: `{ type: 'text', text }` (Vercel AI SDK text format)

**Exit criteria:**

- `pnpm build --filter=@agent-platform/arch-ai` succeeds
- `pnpm build --filter=studio` succeeds
- E2E test E2E-4: upload image with non-vision model, text fallback sent, no crash
- Regression test #22: non-vision model gets text fallback
- Regression test #23: Anthropic vision model gets `source.type: 'base64'` format
- Integration test INT-2: provider-specific format conversion for all 3 providers

**Commit:** `[ABLP-xxx] feat(studio): provider-aware vision capability gating + format conversion`

#### Task 2.3: Clipboard Paste + SVG Sanitization

**Prerequisites:** Add `isomorphic-dompurify` to `packages/arch-ai` dependencies and `dompurify` to `apps/studio` dependencies.

**Files:**

- `apps/studio/src/components/chat/ChatInputBar.tsx`:
  - Add `onPaste` handler to the `<textarea>`:
    ```typescript
    const handlePaste = (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.type.startsWith('image/'));
      if (imageItem) {
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (file) {
          const named = new File([file], `screenshot-${Date.now()}.png`, { type: file.type });
          // Route through existing file attachment pipeline
        }
      }
    };
    ```
  - Add SVG sanitization using DOMPurify before rendering any SVG content (client-side defense)
- `packages/arch-ai/src/session/file-store-service.ts`:
  - SVG server-side sanitization: if `mediaType === 'image/svg+xml'`, run DOMPurify on content before store

**Exit criteria:**

- `pnpm build --filter=studio` succeeds
- Regression test #25: Cmd+V screenshot appears in attachment area
- Regression test #26: upload SVG with `<script>`, DOMPurify strips it
- Manual test: paste screenshot, file appears as pending attachment with thumbnail

**Commit:** `[ABLP-xxx] feat(studio): clipboard paste handler + SVG XSS sanitization`

#### Task 2.4: Failed Image Auto-Skip in Executor

**Files:**

- Update `packages/arch-ai/src/executor/content-block-resolver.ts`:
  - When resolving `image_ref` blocks, if LLM returns 400, catch the error, mark block `status: 'failed'` in StoredMessage
  - Re-attempt the same message without the failed image (text fallback)
  - Emit `file_error` SSE event with `code: 'corrupt'`
  - In `resolveContentBlocks()`, skip any `image_ref` with `status: 'failed'`
- Update `packages/arch-ai/src/session/file-store-service.ts`:
  - `markFailed(ctx, blobId)`: update file status to `'failed'`

**Exit criteria:**

- `pnpm build --filter=@agent-platform/arch-ai` succeeds
- Regression test #24: upload corrupt image, status becomes `'failed'`, subsequent messages skip it
- E2E test E2E-7: concurrent uploads with one corrupt file, message succeeds with valid files only
- Integration test INT-2 case #7: failed image_ref skipped

**Commit:** `[ABLP-xxx] feat(studio): failed image auto-skip in executor`

#### Phase 2 Test Strategy

- **Unit tests**: Worker resize (dimensions validation), token cost per provider (UNIT-3), SVG sanitization
- **Integration tests**: INT-2 (content block resolution for all providers), INT-6 (magic byte verification for images)
- **E2E tests**: E2E-4 (non-vision fallback), E2E-7 (concurrent upload + error recovery)

#### Phase 2 Exit Criteria Summary

- Paste screenshot -> resized in Worker -> uploaded -> vision model analyzes it
- Non-vision model gets text fallback (no crash, no empty response)
- Corrupt image does not brick session (auto-skip in future messages)
- Session resume shows image-carrying messages (thumbnails render)
- 5 concurrent image uploads with per-file progress, no main thread freeze
- SVG XSS stripped on both client and server
- `pnpm build` succeeds across all packages
- Regression tests #21-30 from dev plan review pass

#### Phase 2 Rollback Strategy

1. Revert vision gating -- all images get text fallback (Phase 1 behavior)
2. Worker file removable without impact (upload falls back to main thread encoding)
3. Clipboard paste handler removable from ChatInputBar
4. Failed image skip is additive -- removal means failed images cause retry loops (detectable)

---

### Phase 3: UI Integration

**Goal:** Full visual experience -- file tree shows uploads, token gauge accurate, context menu works, lightbox opens, chat renderers display file badges, and upload has progress indicators.

**i18n Note:** All user-visible strings in Phase 3 must use `useTranslations('arch_in_project')` namespace. Add translation keys to `packages/i18n/locales/en/studio.json`.

**i18n Key Table:**

| Key                      | English Value                                      | Component            |
| ------------------------ | -------------------------------------------------- | -------------------- |
| files.gauge_label        | "File context: {used}K / {total}K tokens"          | TokenBudgetGauge     |
| files.add_button         | "Add files"                                        | IDEPanel             |
| files.group_uploads      | "UPLOADS"                                          | IDEPanel             |
| files.image_failed       | "Could not be processed by AI model"               | ContentBlockRenderer |
| files.confirm_delete     | "Remove {filename}? Also removes from AI context." | FileContextMenu      |
| files.vision_unavailable | "Current model ({name}) can't analyze images"      | ChatInputBar         |
| files.vision_switch      | "Switch model"                                     | ChatInputBar         |
| files.excluded           | "Excluded from AI context"                         | FileStatusBadge      |
| files.evicted            | "Auto-removed from context (budget)"               | FileStatusBadge      |
| files.removed            | "File removed"                                     | ContentBlockRenderer |

#### Task 3.1: IDEPanel UPLOADS Group + Token Budget Gauge

**Files:**

- `apps/studio/src/components/arch-v3/panels/IDEPanel.tsx`:
  - Add new `UPLOADS` group below MOCKS in file tree
  - Filter `filePanelFiles` where `fileType === 'upload'`
  - Display: type badge icon + filename + size
  - Status indicators: green checkmark (active/inContext), gray circle (excluded), amber (evicted), red X (failed)
  - `[+ Add files]` button opens file picker
- Create `apps/studio/src/components/arch-v3/panels/TokenBudgetGauge.tsx`:
  - Props: `{ used: number, total: number }`
  - Color coding: green <70%, amber 70-90%, red >90%
  - Render: `"File context: 47K / 100K tokens [progress bar]"`
  - Place in IDEPanel header
- `apps/studio/src/store/arch-ai-store.ts`:
  - Extend `FilePanelFile` interface with `fileType: 'upload'` and `upload` metadata object
  - Add file SSE event handlers: on `file_processed`, add to `filePanelFiles` with `upload:` key prefix
  - On `file_context_change`, update status indicator

**Exit criteria:**

- `pnpm build --filter=studio` succeeds
- Regression test #31: upload file appears in IDEPanel UPLOADS group
- Regression test #29: upload files totaling 45MB, token gauge shows near-limit
- Token gauge recalculates on model switch (regression test #30)
- Manual test: UPLOADS group visible in BUILD phase only; gauge in header

**Commit:** `[ABLP-xxx] feat(studio): IDEPanel UPLOADS group + token budget gauge`

#### Task 3.2: SpecificationCard Attached Files Section

**Files:**

- `apps/studio/src/components/arch-v3/specification/SpecificationCard.tsx`:
  - Add collapsible "Attached Files ({count})" section below existing spec fields
  - List uploaded files with type badge + filename + size + `[..]` menu
  - Include `TokenBudgetGauge` at bottom of section
  - Show in INTERVIEW and BLUEPRINT phases (not BUILD -- IDEPanel handles that)

**Exit criteria:**

- `pnpm build --filter=studio` succeeds
- Regression test #32: upload during Interview, "Attached Files" appears in SpecificationCard
- Collapsible section expands/collapses correctly
- Token gauge visible within section

**Commit:** `[ABLP-xxx] feat(studio): SpecificationCard attached files section`

#### Task 3.3: Chat Message Content Block Renderers

**Files:**

- Create `apps/studio/src/components/arch-v3/chat/ContentBlockRenderer.tsx`:
  - Props: `{ blocks: ArchContentBlock[] }`
  - Per-block rendering:
    - `text`: render as markdown (existing renderer)
    - `image_ref` (active): thumbnail (max 200px width), click -> lightbox, token cost if >500
    - `image_ref` (failed): red badge "Image failed"
    - `file_ref`: type badge icon + filename + size, syntax-highlighted 6-line preview for code, table preview (3 rows) for CSV, page count badge for PDF
    - `tool_use`/`tool_result`: existing rendering
  - Skeleton loading for thumbnails (lazy load via `IntersectionObserver`)
- Create `apps/studio/src/components/arch-v3/chat/ImageLightbox.tsx`:
  - Full-resolution image viewer modal
  - Focus trap, Escape to close, `aria-label="Image viewer"`
  - Rendered via portal
- Update chat message component to check `rawContent` -- if present, render via `ContentBlockRenderer` instead of plain markdown

**Exit criteria:**

- `pnpm build --filter=studio` succeeds
- Regression test #35: image thumbnail, code syntax preview, PDF badge render correctly
- Regression test #36: click image thumbnail, lightbox opens with focus trap
- Regression test #27: reload after sending image, thumbnails render
- WCAG checks: lightbox has `aria-label`, code blocks have `aria-label`, images have `alt`

**Commit:** `[ABLP-xxx] feat(studio): chat message content block renderers + image lightbox`

#### Task 3.4: File Context Menu + Upload Progress

**Files:**

- Create `apps/studio/src/components/arch-v3/panels/FileContextMenu.tsx`:
  - Per-type action filtering (see design doc section 5.5):
    - Images: View (lightbox), Copy, Download, Exclude, Replace, Delete
    - Code/YAML/JSON: View (expand), Copy, Download, Open in Monaco, Exclude, Replace, Delete
    - PDF: View, Download, Exclude, Replace, Delete
    - CSV: View (table), Copy as JSON, Download, Exclude, Replace, Delete
  - `role="menu"` + `role="menuitem"`, arrow key navigation, Escape closes
  - Delete always confirms: "Remove {filename}? Also removes from AI context."
  - Exclude/Include toggles `file_context_change` SSE
- Add `DuplicateFileDialog` component -- triggered when upload endpoint returns collision. Three actions: Replace (delete old + store new), Keep Both (rename to `{name}-1.{ext}`), Cancel.
- `apps/studio/src/components/chat/ChatInputBar.tsx`:
  - Add drag-and-drop zone: `onDragEnter/Over/Leave/Drop` handlers with blue border glow visual feedback
  - Add upload progress state: `uploadingFiles: Array<{ name: string, progress: number }>`
  - Render progress bars above textarea during upload
  - Model capability warning: amber banner `"Current model ({name}) can't analyze images"` with `[Switch model]`
- `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`:
  - Wire `FileContextMenu` for overlay file interactions

**Exit criteria:**

- `pnpm build --filter=studio` succeeds
- Regression test #34: right-click file, per-type context menu appears
- Regression test #37: upload large file, per-file progress indicator visible
- Regression test #38: delete file, "removed" badge in chat history
- Regression test #33: use FileAttachment in overlay, file uploads successfully
- Manual test: drag file onto chat, blue glow appears, file attaches

**Commit:** `[ABLP-xxx] feat(studio): file context menu + upload progress + drag-drop zone`

#### Phase 3 Test Strategy

- **Manual tests**: Full visual verification -- file tree, token gauge, context menu, lightbox, progress bars, status indicators
- **Unit tests**: ContentBlockRenderer (per-block rendering), TokenBudgetGauge (color thresholds)
- **E2E tests**: E2E-6 (full flow with visual elements)

#### Phase 3 Exit Criteria Summary

- IDEPanel shows UPLOADS group with type badges and status indicators
- Token budget gauge visible in IDEPanel header and SpecificationCard
- File context menu shows per-type actions, delete confirms, exclude toggles context
- Chat messages render file badges (thumbnails, syntax preview, PDF badge, CSV table)
- Image lightbox opens on thumbnail click with focus trap and Escape
- Upload progress bars visible during file upload
- Drag-drop zone active on ChatInputBar with visual feedback
- Amber warning shown when model lacks vision capability
- Deleted files show "removed" badge in chat history
- `pnpm build --filter=studio` succeeds
- Regression tests #31-38 from dev plan review pass

#### Phase 3 Rollback Strategy

1. All Phase 3 changes are UI-only (additive components)
2. Revert renderers -- messages fall back to `normalizeContent()` text display
3. Revert IDEPanel/SpecificationCard extensions -- uploads still work, just not visible in panels
4. No data model changes in Phase 3

---

## 4. Wiring Checklist

Every new component/service/model/route/type that must be wired for the feature to work end-to-end:

| #   | New Thing                   | Wired Into                                                              | How                                                                                                                                                                              | Phase |
| --- | --------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | `ArchContentBlock` type     | `StoredMessage.content` union                                           | Import in `session.ts`, export from `content-blocks.ts`                                                                                                                          | 0     |
| 2   | `normalizeContent()`        | 7 read sites (migration matrix)                                         | Import at each site, call on `m.content`                                                                                                                                         | 0     |
| 3   | 3 SSE Zod schemas           | `ArchSSEEventSchema` discriminated union                                | Add to array in `sse-events.ts:96`                                                                                                                                               | 0     |
| 4   | 3 SSE case handlers         | `useArchChat.ts` switch block                                           | Add `case` branches at line ~589                                                                                                                                                 | 0     |
| 5   | `SessionFileModel`          | `packages/database/src/models/index.ts`                                 | Export from barrel file                                                                                                                                                          | 1     |
| 6   | `FileStoreService`          | Route handler (message/route.ts)                                        | Instantiate in route, pass to resolver                                                                                                                                           | 1     |
| 7   | `POST /api/arch-ai/files`   | Next.js app router                                                      | Create `apps/studio/src/app/api/arch-ai/files/route.ts`                                                                                                                          | 1     |
| 8   | `fileRefs` field            | Message request Zod schema                                              | Add optional field to request validation                                                                                                                                         | 1     |
| 9   | `buildFilePreamble()`       | System prompt builder in route                                          | Call before LLM, prepend result to systemPrompt                                                                                                                                  | 1     |
| 10  | `buildMultimodalMessages()` | LLM messages builder in route                                           | Replace direct `m.content` usage                                                                                                                                                 | 1     |
| 11  | `resolveContentBlocks()`    | Executor pipeline                                                       | Called by `buildMultimodalMessages()`                                                                                                                                            | 1     |
| 12  | `uploadFiles()` client      | `handleChatBarSend` (page.tsx), `handleSendWithFiles` (ArchOverlay.tsx) | Replace `encodeFilesForRequest()`                                                                                                                                                | 1     |
| 13  | `ProviderContentBlock[]`    | `VercelLLMStreamClient.streamChat`                                      | Handle array content in Vercel format conversion                                                                                                                                 | 1     |
| 14  | `image-resize.worker.ts`    | `uploadFiles()` client                                                  | Instantiate Worker, postMessage for oversized images                                                                                                                             | 2     |
| 15  | Vision gating               | `resolveContentBlocks()`                                                | Import `getModelCapabilities` from `@abl/compiler/platform`                                                                                                                      | 2     |
| 16  | Clipboard paste             | `ChatInputBar` textarea                                                 | `onPaste` handler                                                                                                                                                                | 2     |
| 17  | `ContentBlockRenderer`      | Chat message component                                                  | Render when `rawContent` present                                                                                                                                                 | 3     |
| 18  | `ImageLightbox`             | `ContentBlockRenderer`                                                  | Open on thumbnail click                                                                                                                                                          | 3     |
| 19  | `TokenBudgetGauge`          | IDEPanel header, SpecificationCard                                      | Import + render with active file token totals                                                                                                                                    | 3     |
| 20  | `FileContextMenu`           | IDEPanel file tree, SpecificationCard file list                         | Right-click handler on file items                                                                                                                                                | 3     |
| 21  | UPLOADS group               | IDEPanel file tree                                                      | Filter `filePanelFiles` by `fileType === 'upload'`                                                                                                                               | 3     |
| 22  | `FilePanelFile.upload`      | `arch-ai-store.ts`                                                      | Extend interface, populate from `file_processed` SSE                                                                                                                             | 3     |
| 23  | Drag-drop zone              | ChatInputBar outer div                                                  | `onDragEnter/Over/Leave/Drop` handlers                                                                                                                                           | 3     |
| 24  | SessionFile cascade delete  | `ArchSessionModel` post hook                                            | Add Mongoose `post('findOneAndUpdate')` hook on ArchSessionModel that deletes SessionFile records when session state transitions to ARCHIVED. Implemented in Task 1.1.           | 1     |
| 25  | File error types            | `types/errors.ts` barrel, `file-store-service.ts`, route handler        | Export `FileNotFoundError`, `FileTooLargeError`, `FileCorruptError`, `SessionFileQuotaError` from `types/errors.ts` barrel. Import in `file-store-service.ts` and route handler. | 1     |

---

## 5. Cross-Phase Concerns

### 5.1 Database Changes

| Change                                                         | Phase | Rollback                                                       |
| -------------------------------------------------------------- | ----- | -------------------------------------------------------------- |
| `StoredMessage.content` type: `String` -> `Schema.Types.Mixed` | 0     | Revert to `String` -- `normalizeContent()` degrades gracefully |
| New collection: `SessionFileStore`                             | 1     | Drop collection (no other collections affected)                |
| New indexes on `SessionFileStore`                              | 1     | Drop indexes                                                   |

**No data migration needed.** Mongoose `Mixed` accepts both `string` and `ArchContentBlock[]`. Existing sessions with `content: string` continue to work. `normalizeContent()` handles both at read time.

**Cascade delete:** When an `ArchSession` is deleted or archived, cascade-delete all `SessionFileStore` records with matching `sessionId` + `tenantId`. Implement as a post-delete hook on `ArchSessionModel` or as an explicit call in the session cleanup path.

### 5.2 SSE Contract

The SSE contract (`docs/arch/contracts/sse-protocol.md`) must be updated in Phase 0 BEFORE any server-side emission of new events. This is the single highest-risk integration bug (dev plan review section 1.5): if the server emits `file_processed` before the Zod schema includes it, the parser silently drops the event. The feature appears to work from server logs but nothing happens in the UI.

**New events (3):**

| Event                 | Emitted When                    | Key Fields                                                                     |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `file_processed`      | File upload processing complete | `blobId`, `name`, `mediaType`, `size`, `tokenCost`, `metadata`, `smartAction?` |
| `file_error`          | File processing failed          | `fileName`, `error.code`, `error.message`, `recovery[]`                        |
| `file_context_change` | File context status changed     | `blobId`, `change`, `contextBudget?`                                           |

**Total event types after Phase 0:** 16 (13 existing + 3 new)

### 5.3 Chat Freeze Prevention Checklist (Cross-Phase)

Every phase MUST verify these do NOT freeze the chat. Check off during implementation:

| #   | Scenario                            | Prevention                                         | Phase | Verified? |
| --- | ----------------------------------- | -------------------------------------------------- | ----- | --------- |
| 1   | 5 images dropped at once            | Web Worker encoding + per-file progress            | 2     |           |
| 2   | Large file send                     | Separate upload endpoint, <1KB message payload     | 1     |           |
| 3   | Corrupt PDF uploaded                | 30s processing timeout, `file_error` emitted       | 1     |           |
| 4   | 12000x8000 image pasted             | `OffscreenCanvas` in Worker                        | 2     |           |
| 5   | Session resume with content blocks  | `normalizeContent()` type narrowing                | 0     |           |
| 6   | New SSE events emitted              | All 16 types in Zod schema before emission         | 0     |           |
| 7   | File "in context" but LLM can't see | File preamble in system prompt, not sliding window | 1     |           |
| 8   | Upload before session loads         | Queue uploads, show "connecting..." state          | 1     |           |
| 9   | `refreshSession` during stream      | Metadata-only refresh, not full `loadSession`      | 1     |           |
| 10  | `file_processed` after `done`       | Handle file events regardless of chat state        | 0     |           |
| 11  | Phase transition + upload race      | File preamble auto-includes in new phase           | 1     |           |
| 12  | Processing error not caught         | Global 60s streaming timeout -> forced idle        | 1     |           |

### 5.4 Content Migration Matrix Checklist

All 10 consumers of `StoredMessage.content` must use `normalizeContent()`. Track completion:

| #   | Consumer                         | File                                                      | Phase | Done? |
| --- | -------------------------------- | --------------------------------------------------------- | ----- | ----- |
| 1   | TypeScript type                  | `packages/arch-ai/src/types/session.ts:29`                | 0     |       |
| 2   | Mongoose schema                  | `packages/database/src/models/arch-session.model.ts:75`   | 0     |       |
| 3   | Route write (IN_PROJECT)         | `apps/studio/src/app/api/arch-ai/message/route.ts:~1163`  | 1     |       |
| 4   | Route write (ONBOARDING)         | `apps/studio/src/app/api/arch-ai/message/route.ts:~1364`  | 1     |       |
| 5   | LLM message builder (IN_PROJECT) | `apps/studio/src/app/api/arch-ai/message/route.ts:~1233`  | 1     |       |
| 6   | Client message type              | `apps/studio/src/hooks/useArchChat.ts:37`                 | 0     |       |
| 7   | Session restore                  | `apps/studio/src/hooks/useArchChat.ts:125`                | 0     |       |
| 8   | Executor interface               | `packages/arch-ai/src/executor/specialist-executor.ts:46` | 0     |       |
| 9   | Multi-turn executor              | `packages/arch-ai/src/executor/multi-turn-executor.ts:27` | 0     |       |
| 10  | Chat renderer                    | `apps/studio/src/components/arch-v3/chat/`                | 3     |       |

### 5.5 B03-Specific Commit Rules (from Dev Plan Review Section 5)

In addition to standard CLAUDE.md commit rules:

1. Test session resume after every content model change -- #1 silent regression
2. Verify SSE parser accepts new events before emitting them -- #1 integration failure
3. Verify `text_delta` guard after every new message shape -- #1 clobber bug
4. Both route paths -- every change to `processMessage` must also apply to `processInProjectMessage`
5. File events after `done` -- verify server emission order in every streaming test

---

## 6. Acceptance Criteria (Whole-Feature Done)

| #     | Criterion                         | Measurable Gate                                                                                        |
| ----- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| AC-1  | Text file upload works end-to-end | Upload YAML -> blobId returned -> message with content blocks persisted -> LLM references file content |
| AC-2  | Image upload with vision works    | Paste screenshot -> resize in Worker -> upload -> Anthropic vision model analyzes content              |
| AC-3  | Non-vision graceful degradation   | Upload image with text-only model -> text fallback sent -> no crash or empty response                  |
| AC-4  | Session resume no corruption      | Resume session with file-carrying messages -> renders correctly, no `[object Object]`                  |
| AC-5  | Sliding window file persistence   | Upload file at message 1, send 10+ messages -> LLM still references file via preamble                  |
| AC-6  | Both surfaces work                | File upload works from `/arch` page AND `ArchOverlay` (IN_PROJECT)                                     |
| AC-7  | SSE events parsed                 | `file_processed`, `file_error`, `file_context_change` events arrive at client and update UI            |
| AC-8  | File panel integration            | IDEPanel UPLOADS group visible in BUILD, SpecificationCard attached files in INTERVIEW/BLUEPRINT       |
| AC-9  | Token budget gauge                | Gauge shows accurate used/total, color coding correct, recalculates on model switch                    |
| AC-10 | No chat freeze                    | All 12 chat freeze prevention scenarios verified                                                       |
| AC-11 | Zero regression                   | Full Interview -> Blueprint -> Build flow works with file uploads, widgets/gates intact                |
| AC-12 | All 42 regression tests pass      | Regression tests #1-38 from dev plan review (Phase 4 tests #39-42 are separate ticket)                 |
| AC-13 | E2E tests pass                    | E2E-1 through E2E-7 from test spec                                                                     |
| AC-14 | Integration tests pass            | INT-1 through INT-6 from test spec                                                                     |
| AC-15 | `pnpm build` clean                | All affected packages build without errors                                                             |

> **Note:** FR-19 (Monaco editing for uploaded files) is deferred to OQ-6. The context menu "Open in Monaco" action opens files read-only until OQ-6 is implemented.

---

## 7. Open Questions

| #    | Question                                                                      | Status   | Resolution                                                                                                                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Should Phase 4 (smart routing) be a separate Jira ticket?                     | RESOLVED | Yes -- core B03 = Phases 0-3. Smart routing (OpenAPI import, ABL compile, CSV schema, PDF summarize) follows as separate ticket. Regression tests #39-42 deferred.                                                                                                        |
| OQ-2 | GridFS implementation: use existing platform GridFS or standalone?            | RESOLVED | Use mongoose's built-in `GridFSBucket` from `mongoose.connection.db` -- no external library needed. GridFS operations handled in `file-store-service.ts` with `bucket.openUploadStream()` / `bucket.openDownloadStream()`. 4MB threshold per D4.                          |
| OQ-3 | Token gauge: calculate from model's context window or use fixed budget?       | RESOLVED | Use `getModelCapabilities(activeModelId).contextWindow` dynamically. Gauge recalculates on model switch.                                                                                                                                                                  |
| OQ-4 | Should `collect_file` widget auto-dismiss on proactive upload?                | RESOLVED | Yes, if uploaded file type matches requested type (edge case E3). Deferred to separate follow-up ticket.                                                                                                                                                                  |
| OQ-5 | `VercelLLMStreamClient` -- does Vercel AI SDK support image content natively? | RESOLVED | Vercel AI SDK's `streamText` accepts `ImagePart` via the provider adapter layer. The SDK converts content arrays to provider format. Verified with `@ai-sdk/anthropic` which maps image blocks to Claude's `image` content type.                                          |
| OQ-6 | Monaco editing for uploaded text files in BUILD phase                         | DEFERRED | Requires: open in IDEPanel editor -> edit -> save back to FileStoreService -> update preamble -> recalculate tokenEstimate. Deferred to a follow-up ticket after Phase 3 ships. The context menu shows 'Open in Monaco' but it opens read-only until this OQ is resolved. |

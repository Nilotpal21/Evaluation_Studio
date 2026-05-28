# HLD: B03 Multimodality Support (Arch v0.3)

**Feature**: B03 (File Upload Enhancement — IDE-Grade + Multimodal)
**Design Doc**: [docs/arch/research/2026-04-05-multimodality-design.md](../arch/research/2026-04-05-multimodality-design.md)
**Research**: [docs/arch/research/2026-04-05-multimodality-research.md](../arch/research/2026-04-05-multimodality-research.md)
**Reviews**: [Claude 4.6 Opus](../arch/review/2026-04-05-claude-4.6-opus-multimodality-review.md), [GPT-5.4 Codex](../arch/review/2026-04-05-gpt-5.4-codex-multimodality-review.md)
**Dev Plan Review**: [docs/arch/research/2026-04-05-multimodality-dev-plan-review.md](../arch/research/2026-04-05-multimodality-dev-plan-review.md)
**Status**: IMPLEMENTED
**Last Updated**: 2026-04-05

---

## 1. Problem Statement

Arch is text-only. Users cannot share screenshots, specs, wireframes, or data files with the AI architect. Every competitor (v0, Lovable, Bolt, Cursor, Windsurf, Devin, Replit Agent) supports multimodal file input. This is a table-stakes gap. B03 is the critical unlock for 7 downstream features (B19, B32, B33, B34, B35, B37, B48).

The implementation spans all 4 tiers of B03:

- **Tier 1:** Basic file sharing (any phase, any mode)
- **Tier 2:** Image/screenshot support (paste, drag-drop, vision)
- **Tier 3:** Persistent file context (session-scoped, cross-phase)
- **Tier 4:** Smart file handling (OpenAPI auto-import, ABL compile, CSV schema, PDF summarize)

The implementation must preserve the platform's core invariants: tenant isolation at the query level, centralized auth, stateless distributed execution, traceability, and compliance with encryption and data minimization requirements.

---

## 2. Alternatives Considered

### Alternative A: Inline Base64 in Messages (Rejected)

**Description**: Embed file content as base64 directly in `POST /api/arch-ai/message` body. No separate upload endpoint. Files are part of the message payload.

**Pros**:

- Single-step send (no upload-then-reference)
- Simpler implementation (no new endpoint)

**Cons**:

- 5 images at 10MB each = 68MB base64 payload, causing main-thread freeze during encoding, POST with no progress indication, and server memory pressure
- No per-file progress indicators or retry capability
- Hits Next.js payload limits (4.5MB free, 50MB Pro) and MongoDB 16MB BSON document limit
- Chat appears frozen while upload happens (user sees "streaming" state but POST has not completed)

**Effort**: M

### Alternative B: Multipart Form Upload (Rejected)

**Description**: Use `multipart/form-data` for `POST /api/arch-ai/message` instead of JSON. Files sent as form fields alongside the text message.

**Pros**:

- Native browser file upload (streaming, no base64 encoding overhead)
- Single request per message

**Cons**:

- Cannot show per-file progress for individual files
- Failed files block the entire message
- Does not separate concerns (upload lifecycle vs message lifecycle)
- No retry for individual files without re-uploading all

**Effort**: M

### Alternative C: Hybrid C — Content Blocks + External Blobs (Chosen)

**Description**: Upload-then-reference architecture. Files uploaded via separate `POST /api/arch-ai/files` endpoint, returning a `blobId`. Messages reference files by `blobId` only. `StoredMessage.content` becomes `string | ArchContentBlock[]` where image/file blocks store references, not inline data. External `SessionFileStore` collection holds file blobs.

**Pros**:

- Per-file progress bars (each file is a separate POST)
- Message payload stays <1KB (blobId references only)
- Failed uploads do not block message send
- Retry individual files without re-uploading all
- Files independently manageable (exclude, evict, delete)
- Server processes files in parallel
- No main-thread freeze (encoding in Web Worker)
- Aligns with Claude Files API pattern

**Cons**:

- Two-step flow (upload then send) adds complexity
- Extra collection (SessionFileStore) to manage
- Cross-cutting migration of `StoredMessage.content` across 10 consumers

**Effort**: L

### Recommendation

**Alternative C** is the chosen approach. Both independent reviewers (Claude 4.6 Opus and GPT-5.4 Codex) flagged Alternatives A/B as critical risks (3 freeze vectors) and independently recommended the upload-then-reference pattern. The two-step flow is mitigated by the upload being transparent to users (files upload immediately on drop/paste, blobIds are attached to the next send).

---

## 3. Architecture

### 3.1 System Context Diagram

```
                    ┌──────────────────────────────────┐
                    │         User Browser              │
                    │ ┌───────────────────────────────┐ │
                    │ │  ChatInputBar + File Input     │ │
                    │ │  (paste, drag-drop, picker)    │ │
                    │ └──────┬────────────┬────────────┘ │
                    │        │ files      │ text + refs  │
                    └────────┼────────────┼──────────────┘
                             │            │
           ┌─────────────────┘            └──────────────────┐
           │                                                 │
           ▼                                                 ▼
  POST /api/arch-ai/files              POST /api/arch-ai/message
  (per-file, with progress)            (blobId refs only, <1KB)
           │                                                 │
           ▼                                                 ▼
  ┌─────────────────┐                 ┌──────────────────────────┐
  │ File Processing  │                 │ Route Handler             │
  │ - Validate       │                 │ - Resolve blobIds         │
  │ - Magic bytes    │                 │ - Build ArchContentBlock[]│
  │ - Extract meta   │                 │ - Persist StoredMessage   │
  │ - Compute tokens │                 │ - Inject file preamble    │
  │ - Store blob     │                 │ - Call executor           │
  └────────┬────────┘                 └─────────┬────────────────┘
           │                                     │
           ▼                                     ▼
  ┌─────────────────┐                 ┌──────────────────────────┐
  │ SessionFileStore │                 │ Specialist Executor       │
  │ (MongoDB)        │◄────────────────│ - getModelCapabilities() │
  │ - blobId         │ resolve blob    │ - Provider format convert│
  │ - content Buffer │                 │ - Vision/text fallback   │
  │ - metadata       │                 │ - File preamble build    │
  │ - status         │                 └─────────┬────────────────┘
  └─────────────────┘                            │
                                                 ▼
                                       ┌──────────────────┐
                                       │ LLM Provider API  │
                                       │ (Anthropic/OpenAI/│
                                       │  Google)          │
                                       └──────────────────┘
```

### 3.2 Upload-Then-Reference Flow

```
Step 1: Upload (separate, per-file)
─────────────────────────────────────
User drops files → Client validation (size, type, count, dimensions)
  → Image resize in Web Worker (OffscreenCanvas, >1568px)
  → Base64 encode in Web Worker
  → POST /api/arch-ai/files { sessionId, file: { name, type, size, content } }
  → Server: validate, magic bytes, SHA-256 dedup, store in SessionFileStore
  → Server: extract metadata with per-type timeout (5-30s)
  → Response: { blobId, metadata, tokenCost }
  → Client: show file chip with token cost badge

Step 2: Send message (lightweight)
──────────────────────────────────
User hits send → POST /api/arch-ai/message { text, fileRefs: [{ blobId }] }
  → Route: resolve blobIds → SessionFile records
  → Route: build ArchContentBlock[] (text + image_ref + file_ref)
  → Route: persist StoredMessage with content blocks
  → Route: inject active files into system prompt preamble
  → Executor: resolve blocks → provider-specific format
  → Executor: call LLMStreamClient.streamChat()
  → SSE: stream response + emit file_processed events
```

### 3.3 Provider-Aware Executor Resolution

```
User sends message with files
       │
       ▼
Executor calls getModelCapabilities(activeModelId)
       │
       ▼
For each image_ref block:
       │
       ├── supportsVision: true
       │   └── Resolve blobId → base64 from SessionFileStore
       │       └── Convert to provider-specific format:
       │           ├── Anthropic: { type: 'image', source: { type: 'base64', media_type, data } }
       │           ├── OpenAI:    { type: 'image_url', image_url: { url: 'data:{mime};base64,{data}' } }
       │           └── Google:    { inlineData: { mimeType, data } }
       │
       └── supportsVision: false
           └── Text fallback: "[Image: {name}, {w}x{h}, {type}]"

For each file_ref block:
       │
       └── Resolve blobId → text content from SessionFileStore
           ├── Within budget → inline: "[File: {name}]\n{content}\n[/File]"
           └── Over budget  → truncate: "[File: {name}]\n{first 50K chars}\n[Truncated]\n[/File]"
```

### 3.4 File Preamble Injection (System Prompt)

Active files are injected as a preamble block in the system prompt, outside the sliding conversation window. This ensures files persist across the `slice(-8)` message boundary.

```
Context budget (200K tokens example):
├── System prompt:        ~5K   (fixed)
├── Specification:        ~2K   (fixed)
├── FILE PREAMBLE:        ~45K  (injected — active files, outside sliding window)
├── Conversation window:  ~100K (sliding — last N messages)
└── Response reserve:     ~48K  (fixed)
```

**Preamble format:**

```
[Session Files]
[File: api-spec.yaml (YAML, 2.4KB)]
openapi: "3.0.3"
...
[/File]
[Image: wireframe.png (PNG, 1200x800, 1.2MB) — vision analysis active]
[/Session Files]
```

**Eviction order when budget exceeded:**

1. Oldest messages slide out first (existing behavior)
2. If still over, files evicted from preamble oldest-first
3. Images evicted before text files (higher token cost, lower re-reference value)
4. User notified via `file_context_change` SSE event
5. File panel indicators sync with preamble state (not message position)

**Design decision rationale (review H1):** Both reviewers flagged that `storedMessages.slice(-8)` drops file context while the UI shows "in context" — the most trust-damaging bug possible. Preamble injection guarantees the file panel always matches LLM reality.

---

## 4. Architectural Concerns

### 4.1 Resource Isolation (Tenant, Project, User, Session)

**Tenant isolation:** Every `SessionFileStore` query includes `tenantId`. The upload endpoint validates `tenantId` from the auth context. Index `{ tenantId, sessionId }` enforces query-level isolation.

**Project isolation:** Files are session-scoped, and sessions are project-scoped (via `ArchSession.projectId` when in IN_PROJECT mode). The upload endpoint verifies session ownership before accepting files.

**User isolation:** Sessions are created by users. The upload endpoint checks `session.createdBy === req.user.id` before accepting files. Cross-user file access returns 404 (not 403, per platform convention).

**Session isolation:** `SessionFileStore._id` (blobId) is session-scoped. SHA-256 dedup operates within a single session only — no cross-session blob sharing. Session deletion cascades to file store cleanup.

**Indexes:**

- `{ sessionId, status }` — primary query pattern
- `{ sessionId, hash }` — dedup lookup
- `{ tenantId, sessionId }` — tenant isolation enforcement

### 4.2 Authentication & Authorization

**Upload endpoint** (`POST /api/arch-ai/files`): Uses `createUnifiedAuthMiddleware` / `requireAuth` (centralized auth). No custom token verification. The endpoint:

1. Validates JWT via existing auth middleware
2. Resolves `tenantId` from token claims
3. Validates `sessionId` ownership (session belongs to requesting user + tenant)
4. Rate limits uploads (per-session: 50MB total, per-file: 10MB)

**Message endpoint** (`POST /api/arch-ai/message`): Existing auth. File references (`blobId`) are validated against `SessionFileStore` with `tenantId` + `sessionId` match — prevents blobId guessing/spoofing across sessions.

**No new permission scopes required.** File upload/reference is scoped within existing Arch session permissions.

### 4.3 Data Model & Storage

**ArchContentBlock (new union type):**

```typescript
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
```

**StoredMessage migration:**

```typescript
// content: string → content: string | ArchContentBlock[]
```

**SessionFileStore (new MongoDB collection):**

```typescript
interface SessionFile {
  _id: string; // blobId (uuidv7 — matches session ID strategy)
  sessionId: string;
  tenantId: string;
  name: string;
  mediaType: string;
  size: number;
  hash: string; // SHA-256 for dedup
  content: Buffer; // GridFS ref for >4MB (safe headroom below 16MB BSON limit)
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
```

**Design decision (review H8):** `blobId` uses `uuidv7` for consistency with session IDs — not nanoid or ObjectId.

**Design decision (review E5):** GridFS threshold set at 4MB (not 8MB as originally designed) to leave safe headroom below the 16MB BSON document limit when metadata is included.

**Size limits:**

| Limit            | Value                                | Rationale                                      |
| ---------------- | ------------------------------------ | ---------------------------------------------- |
| Per file         | 10MB                                 | Aligned with Bolt free tier, Claude API limits |
| Per message      | 10 text + 5 images                   | Matches S1-F10/F11 feature specs               |
| Per session      | 50MB total                           | Prevents runaway storage                       |
| Image dimensions | 8000x8000px max, auto-resize >1568px | Claude API limits, avoids latency penalty      |
| Text truncation  | 50K characters                       | Token budget management                        |

### 4.4 API Design

**New endpoint:**

```
POST /api/arch-ai/files
  Request: { sessionId, file: { name, type, size, content: base64 } }
  Response: { blobId, metadata, tokenCost }
  Errors: 400 (validation), 413 (too large), 422 (corrupt/unprocessable)
```

**Modified endpoint:**

```
POST /api/arch-ai/message
  Request: { sessionId, type, text, fileRefs?: [{ blobId }] }
  (existing fields unchanged, fileRefs is additive)
```

**Route decision (review C5):** All multimodal work targets `/api/arch-ai/message` (session-aware route). The stateless `/api/arch-ai/chat` route (Vercel AI SDK) is explicitly out of scope for B03.

**SSE protocol additions (3 new events):**

| Event                 | Purpose                     | Key Fields                                                    |
| --------------------- | --------------------------- | ------------------------------------------------------------- |
| `file_processed`      | File processing complete    | `blobId`, `name`, `tokenCost`, `metadata`, `smartAction?`     |
| `file_error`          | File processing failed      | `fileName`, `error: { code, message }`, `recovery[]`          |
| `file_context_change` | File context status changed | `blobId`, `change` (evicted/included/excluded/deleted/failed) |

### 4.5 Error Handling & Resilience

**Error taxonomy (12 classes across 4 tiers):**

**Tier 1 — Client-side validation (instant, pre-upload):**

| Error            | Detection            | Recovery                          |
| ---------------- | -------------------- | --------------------------------- |
| File too large   | `file.size > 10MB`   | Select different file             |
| Unsupported type | Extension + MIME     | Select different file             |
| Too many files   | Count check          | Auto-remove excess, user confirms |
| Empty file       | `file.size === 0`    | Select different file             |
| Session full     | Running total > 50MB | Manage files panel                |
| Image oversized  | Client Image() load  | Silent auto-resize to 1568px      |

**Tier 2 — Server-side processing (via `file_error` SSE):**

| Error                | Detection          | Recovery                        |
| -------------------- | ------------------ | ------------------------------- |
| Base64 decode fail   | Decode error       | Retry upload                    |
| Corrupt image        | Header/decode fail | Try again, Remove               |
| PDF parse failure    | Parser error       | Upload as image, Remove         |
| Magic bytes mismatch | Header vs MIME     | Try again                       |
| Invalid OpenAPI      | Schema validation  | View errors, Attach as raw YAML |
| Processing timeout   | Per-type timeout   | File attached as reference only |

**Tier 3 — Runtime errors (during LLM call):**

| Error             | Detection      | Recovery                    |
| ----------------- | -------------- | --------------------------- |
| LLM rejects image | API 400        | Remove image and retry      |
| LLM timeout       | Timeout        | Retry, Retry without images |
| Context overflow  | Token error    | Auto-exclude oldest files   |
| Provider down     | Connection err | Retry                       |

**Tier 4 — State errors (session/history):**

| Error          | Detection        | Recovery                            |
| -------------- | ---------------- | ----------------------------------- |
| File missing   | blobId not found | Show "unavailable" badge            |
| Duplicate name | Name collision   | Replace / Keep both / Cancel dialog |

**Unrecoverable image prevention (design section 7.5):** When the LLM returns 400 for an image, the executor: (1) marks the `image_ref` block as `status: 'failed'` in StoredMessage, (2) re-attempts the same message without the failed image using text fallback, (3) emits `file_error` SSE, (4) future messages auto-skip failed `image_ref` blocks. This prevents the Claude Code session-poisoning bug where a bad image makes every subsequent message fail.

### 4.6 Performance & Scalability

**Client-side performance:**

- Image resize uses `OffscreenCanvas` in Web Worker — no main-thread blocking for 12000x8000 images (review H5)
- Base64 encoding runs in Web Worker — no main-thread freeze for large files (review C2/C3)
- File uploads are per-file with per-file progress bars — no 68MB single payload
- Message POST carries only blobId references (<1KB)
- Thumbnails lazy-loaded via `IntersectionObserver`
- Monaco editor lazy-loaded (~2MB bundle) only on "Edit" click

**Server-side performance:**

- Per-type processing timeouts: images 10s, CSV 10s, DOCX 15s, OpenAPI 15s, PDF 30s (review H4)
- SHA-256 dedup prevents re-processing identical files in the same session
- Files stored in separate collection (not inline in ArchSession document)
- GridFS for files >4MB avoids BSON document size pressure
- File processing is independent per file — parallelizable

**Token budget management:**

- File context budget: dynamic allocation within model context window
- Text files: `characters / 4` tokens
- Images: `(width * height) / 750` tokens (Claude formula)
- PDF pages: ~1500 tokens/page
- Token gauge color coding: green <70%, amber 70-90%, red >90%
- Auto-eviction: oldest files evicted first, images before text files

### 4.7 Observability & Tracing

**Upload events:**

- File upload start/complete/error traced via `TraceEvent`
- Per-file processing time tracked (metadata extraction duration)
- File validation failures logged with file type, size, and rejection reason

**SSE events:**

- `file_processed`, `file_error`, `file_context_change` are observable in both server logs and client-side event handlers
- The 3-way mismatch between Zod schema, contract, and server emissions is resolved as prerequisite 1 — all 18 event types are aligned

**Context budget tracking:**

- File preamble token cost logged per LLM call
- Context overflow events logged when files are auto-evicted
- Model switch events logged with budget recalculation

### 4.8 Security

**File validation (defense in depth):**

- Client-side: extension allowlist, MIME type check, file size check
- Server-side: magic bytes verification (header bytes match claimed MIME type — prevents extension spoofing)
- Server-side: base64 decode validation (prevents malformed payloads)

**XSS prevention (review E6):**

- SVG files sanitized via DOMPurify on both client (before render) and server (before store)
- Defense in depth — server-only sanitization can be bypassed by direct store access
- SVGs rendered via `<img>` tag (sandboxed), not inline `<svg>` (executable)

**Image safety:**

- EXIF metadata stripped on upload (prevents location/device leakage)
- Images auto-resized client-side (prevents memory exhaustion attacks via huge dimensions)
- Failed image blocks marked and auto-skipped (prevents session poisoning)

**Upload rate limiting:**

- Per-session: 50MB total storage
- Per-file: 10MB maximum
- Per-message: 10 text files + 5 images
- Processing timeouts prevent resource exhaustion from malformed files

### 4.9 Provider Abstraction (Multi-Model Vision Support)

The platform's existing `ModelCapabilities` registry (`getModelCapabilities()`) already tracks `supportsVision`, `contextWindow`, and `provider` per model. B03 extends this for multimodal:

**Provider-specific behavior:**

| Concern              | Claude (Anthropic)                                   | GPT-4o/5 (OpenAI)                                       | Gemini (Google)                      | No Vision     |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------- | ------------------------------------ | ------------- |
| Image support        | Native vision                                        | Native vision                                           | Native vision                        | Text fallback |
| Token formula        | `(w*h)/750`                                          | ~85 tokens/tile (512x512)                               | Varies by resolution                 | N/A           |
| Max dimensions       | 8000x8000px                                          | 2048x2048 (short side)                                  | No hard limit                        | N/A           |
| Max per request      | 20                                                   | ~10-20                                                  | 16                                   | N/A           |
| Content block format | `{ type: 'image', source: { type: 'base64', ... } }` | `{ type: 'image_url', image_url: { url: 'data:...' } }` | `{ inlineData: { mimeType, data } }` | N/A           |
| Auto-resize          | >1568px                                              | >2048px                                                 | None                                 | N/A           |

**Non-vision graceful degradation:**

1. Image stored in SessionFileStore (viewable in file panel, BUILD tree)
2. LLM receives text metadata: `[Image attached: wireframe.png, 1200x800px, PNG — vision unavailable with current model]`
3. Chat shows amber warning with `[Switch model]` action
4. Switching to a vision model enables vision for new messages only — no automatic re-send

**LLMStreamClient interface change:**

```typescript
// messages[].content: string → string | ProviderContentBlock[]
```

The executor converts `ArchContentBlock[]` (storage format) to provider-specific `ProviderContentBlock[]` (API format) at call time.

**Design decision (review E4):** Token gauge recalculates immediately on model switch using the new provider's formula. File panel indicators update accordingly.

### 4.10 State Management

**File status state machine:**

```
                    ┌──────────┐
          upload    │  active   │◄────── re-include
         ────────►  │ inContext │
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
              ▼          ▼          ▼
        ┌──────────┐ ┌────────┐ ┌────────┐
        │ excluded │ │evicted │ │deleted │
        │ (user)   │ │(budget)│ │ (user) │
        └──────────┘ └────────┘ └────────┘
              │          │          │
              └──────┬───┘          │
              re-include            ▼
                              ┌────────┐
                              │ failed │
                              │(LLM 4xx)│
                              └────────┘
```

Transitions:

- `active` → `excluded`: User right-clicks "Exclude from context"
- `active` → `evicted`: Context budget exceeded (auto)
- `active` → `deleted`: User deletes file
- `active` → `failed`: LLM returns 400 for image
- `excluded`/`evicted` → `active`: User re-includes
- `deleted`/`failed`: Terminal states (metadata preserved for history badges)

**Session lifecycle:**

- Files created during session via `POST /api/arch-ai/files`
- Files persist across phase transitions (INTERVIEW → BLUEPRINT → BUILD → CREATE)
- File preamble auto-includes in new phase system prompts (review E2)
- On project creation (CREATE), relevant files copied to project assets
- On session deletion, `SessionFileStore` records cascade-deleted

**Chat state interactions:**

- File attachment allowed during streaming (component state persists across streaming transitions, review E1)
- Send guard blocks POST only, not attachment UI
- `file_processed` events handled regardless of chat state (not gated on `streaming`, review E10)
- `refreshSession` uses metadata-only refresh during active streams (not full `loadSession`)
- `collect_file` widget auto-satisfied by proactive upload if file type matches (review E3)

### 4.11 UI Architecture

**ChatInputBar extensions (existing component, extended):**

- Clipboard paste handler (`onPaste` on textarea): intercept `Cmd+V` for `image/*` items
- Drag-and-drop zone (`onDragEnter/Over/Leave/Drop`): visual drop target with blue glow
- Upload progress: per-file progress bars during `POST /api/arch-ai/files`
- Token cost badges on file chips
- Model capability warning: amber banner when vision unavailable
- Encoding flow change: replace `encodeFilesForRequest()` with `uploadFiles()` → blobIds → `send(text, { fileRefs })`

**IDEPanel extensions (BUILD phase):**

- New UPLOADS group in file tree (alongside AGENTS and MOCKS)
- Token budget gauge in header: `"File context: 47K / 100K tokens [━━━━━░░░░]"`
- Per-file status indicators (green checkmark = in context, gray circle = excluded)
- Session storage gauge at bottom
- Per-type context menu (View, Copy, Download, Edit, Import, Delete)
- Uploaded file key prefix: `upload:` to avoid collision with generated files (review H6)

**SpecificationCard extensions (INTERVIEW/BLUEPRINT):**

- Collapsible "Attached Files" section with file list and token gauge

**Chat message renderers (per file type):**

| File Type      | Inline Rendering                            | Full View           |
| -------------- | ------------------------------------------- | ------------------- |
| Images         | Thumbnail (max 200px, skeleton placeholder) | Lightbox modal      |
| Code/YAML/JSON | Syntax-highlighted 6-line preview           | Monaco editor tab   |
| PDF            | Page count badge + token estimate           | Multi-page viewer   |
| CSV            | 3-row table preview                         | Virtualized table   |
| DOCX           | Extracted text preview (30 lines)           | Full extracted text |
| Binary         | Icon + filename + size + MIME badge         | Download only       |

**ArchOverlay extensions (IN_PROJECT mode):**

- `onDragOver`/`onDrop` handlers on container to prevent browser file navigation (review E9)
- ChatInputBar with file support (unified component, compact variant)

### 4.12 Migration & Backward Compatibility

**Content migration matrix (10 consumers):**

| Layer                  | File                        | Current                            | Change                                                                                                 |
| ---------------------- | --------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| TypeScript type        | `session.ts:29`             | `content: string`                  | `content: string \| ArchContentBlock[]`                                                                |
| Mongoose schema        | `arch-session.model.ts:75`  | `content: { type: String }`        | `content: { type: Schema.Types.Mixed }` + runtime validation                                           |
| Route write path       | `route.ts:995,1045`         | `content: msg.text`                | Build `ArchContentBlock[]` from text + resolved fileRefs                                               |
| LLM message builder    | `route.ts:1047`             | `Array<{ content: string }>`       | `Array<{ content: string \| ProviderContentBlock[] }>` via executor                                    |
| Client message type    | `useArchChat.ts:22`         | `ChatMessage.content: string`      | Add `rawContent?: ArchContentBlock[]`; `content` stays string (display text)                           |
| Session restore        | `useArchChat.ts:108`        | `content: m.content` (as string)   | `content: normalizeContent(m.content)`, `rawContent: Array.isArray(m.content) ? m.content : undefined` |
| Executor interface     | `specialist-executor.ts:45` | `messages[].content: string`       | `messages[].content: string \| ProviderContentBlock[]`                                                 |
| Multi-turn executor    | `multi-turn-executor.ts:27` | `MultiTurnMessage.content: string` | `MultiTurnMessage.content: string \| ProviderContentBlock[]`                                           |
| SSE text_delta handler | `useArchChat.ts:~300`       | Appends delta to `content: string` | Unchanged — streaming response is always text                                                          |
| Chat message renderer  | `arch-v3/chat/`             | Renders content as markdown        | If `rawContent` exists, render per-block                                                               |

**`normalizeContent()` helper (backward compatibility):**

```typescript
function normalizeContent(content: string | ArchContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
```

**Migration must be atomic** across all 10 consumers in a single vertical slice (review C1). Partial migration causes `[object Object]` corruption. The `normalizeContent()` call at every read site ensures existing `string` messages continue to work identically.

**Rollback safety:** `normalizeContent()` degrades gracefully — `ArchContentBlock[]` becomes extracted text. No data loss, just loss of rich rendering. Mongoose `Mixed` type accepts both `string` and `ArchContentBlock[]`, so no data migration is needed for existing sessions (review E11).

**SSE protocol migration:** Prerequisite 1 aligns the 3-way mismatch between Zod schema (13 types), contract doc (15 types), and server emissions. New total after alignment: 16 types in contract, 15 in Zod schema (dead types removed, B03 + B05 types added).

---

## 5. Design Decisions from Reviews

Both Claude 4.6 Opus and GPT-5.4 Codex independently reviewed the design on 2026-04-05 and found 4 critical issues with significant overlap. All criticals were resolved in the design phase.

### Critical Resolutions

| ID    | Finding                                                                                | Resolution                                                                                                         |
| ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| C1    | `StoredMessage.content` migration is deeper than described — 7 layers enforce `string` | Added content migration matrix (10 consumers). Atomic vertical slice with `normalizeContent()` at every read site. |
| C2/C3 | Base64 in message body creates 3 freeze vectors (encoding, payload, memory)            | Redesigned to upload-then-reference: separate `POST /api/arch-ai/files` + Web Worker encoding + per-type timeouts. |
| C4    | New SSE events silently dropped by Zod parser                                          | Schema-first prerequisite: align Zod with contract, add B03 events before any feature code.                        |
| C5    | Two Arch routes with incompatible file handling                                        | All work targets `/api/arch-ai/message`. `/api/arch-ai/chat` out of scope.                                         |

### High Priority Resolutions

| ID  | Finding                                    | Resolution                                                  | Phase   |
| --- | ------------------------------------------ | ----------------------------------------------------------- | ------- |
| H1  | Sliding window drops file context, UI lies | File preamble injection in system prompt (outside window)   | Phase 1 |
| H2  | Session resume shows `[object Object]`     | `normalizeContent()` in loadSession                         | Phase 1 |
| H3  | ArchOverlay has no attachment UI           | Add FileAttachment + drag-drop to overlay                   | Phase 3 |
| H4  | No processing timeouts                     | `Promise.race` per-type (5-30s), fallback to reference only | Phase 1 |
| H5  | Canvas resize freezes main thread          | `OffscreenCanvas` in Web Worker                             | Phase 2 |
| H6  | `metadata.files` naming collision          | Prefix uploaded file keys with `upload:`                    | Phase 1 |
| H7  | Research section 10 contradicts design     | SUPERSEDED banner added                                     | Pre-LLD |
| H8  | blobId generation strategy ambiguous       | Standardize on `uuidv7`                                     | Phase 1 |

### Edge Case Decisions

| ID  | Edge Case                                 | Decision                                                                           |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| E1  | File attachment during streaming          | Files persist in component state across transitions. Send guard blocks POST only.  |
| E2  | Phase transition during file processing   | File preamble auto-includes all active files in new phase system prompt.           |
| E3  | `collect_file` widget vs proactive upload | Proactive upload auto-satisfies pending widget if file type matches.               |
| E4  | Model switch recalculates tokens          | Token gauge recalculates immediately using new provider formula.                   |
| E5  | Network failure preserves draft           | Files already uploaded survive message POST failure. One-click retry.              |
| E6  | SVG XSS                                   | DOMPurify on both client and server. Defense in depth.                             |
| E7  | Duplicate filename across phases          | Replace / Keep both / Cancel dialog. Dedup by hash is separate.                    |
| E8  | Session image cap                         | No hard cap. 50MB session total is sufficient (~40 images naturally).              |
| E9  | ArchOverlay drag-drop                     | Add `onDragOver`/`onDrop` preventDefault on overlay container.                     |
| E10 | `file_processed` after `done`             | Handle file events regardless of chat state. Emit `file_processed` BEFORE `done`.  |
| E11 | Existing sessions with `content: string`  | Mongoose Mixed accepts both. `normalizeContent()` handles both. No data migration. |

---

## 6. Implementation Prerequisites

5 hard blockers that must be committed before any feature code:

| #   | Prerequisite                  | Purpose                                                                         | Commit Type |
| --- | ----------------------------- | ------------------------------------------------------------------------------- | ----------- |
| P1  | SSE contract/schema alignment | Align Zod (13 types) with contract (15 types), add B03 events, remove dead spec | refactor    |
| P2  | StoredMessage content prep    | Create ArchContentBlock type, normalizeContent(), update all 10 consumers       | refactor    |
| P3  | ArchOverlay drag prevention   | Add preventDefault handlers to block browser file navigation                    | fix         |
| P4  | ChatInputBar files wiring     | **RESOLVED** — unified chat input landed, files wired on both surfaces          | N/A         |
| P5  | Research/design consistency   | SUPERSEDED banner on research section 10, authoritative-design pointer          | docs        |

---

## 7. Implementation Sequencing

**Phase 0: Prerequisites** — Zero-feature changes (section 6 above).

**Phase 1: Upload Endpoint + Content Blocks (Text Files Only)** — `POST /api/arch-ai/files`, SessionFileStore collection, ArchContentBlock types, StoredMessage migration (10 consumers), normalizeContent(), file preamble injection, processing timeouts. Exit criteria: upload YAML, persist with content blocks, LLM sees file, session resume works, sliding window preserves context.

**Phase 2: Image Upload + Vision** — Web Worker resize (OffscreenCanvas), vision gating via ModelCapabilities, provider-specific format conversion, graceful degradation, auto-fallback for failed images, clipboard paste, SVG sanitization. Exit criteria: paste screenshot, vision model analyzes it, non-vision model gets text fallback, bad image does not brick session.

**Phase 3: UI Integration** — IDEPanel UPLOADS group, SpecificationCard files section, ArchOverlay attachment UI, token budget gauge, context menu, chat renderers, lightbox, upload progress. Exit criteria: full visual experience with all file states and renderers working.

**Phase 4: Smart Routing (Tier 4)** — OpenAPI import, ABL compile, CSV schema analysis, PDF summarization. Exit criteria: upload OpenAPI spec, see "Import as tools?" suggestion, click, tools imported.

---

## 8. Supported File Types

| Category   | Extensions                                | Rendering               | Editable |
| ---------- | ----------------------------------------- | ----------------------- | -------- |
| Images     | .png, .jpg, .jpeg, .webp, .gif            | Thumbnail + lightbox    | No       |
| Vector     | .svg                                      | Inline render + code    | Yes      |
| PDF        | .pdf                                      | Page thumbnail + viewer | No       |
| Markdown   | .md                                       | Rendered HTML + raw     | Yes      |
| JSON       | .json                                     | Syntax highlight + tree | Yes      |
| YAML       | .yaml, .yml                               | Syntax highlighted      | Yes      |
| CSV        | .csv                                      | Table preview           | Yes      |
| Plain text | .txt                                      | Monospace text          | Yes      |
| Word       | .docx                                     | Extracted text          | No       |
| OpenAPI    | .openapi (yaml/json)                      | Endpoint summary        | Yes      |
| Code       | .js, .ts, .py, .go, .rs, .rb, .java, .sql | Syntax highlighted      | Yes      |
| ABL        | .abl                                      | ABL syntax highlighted  | Yes      |

**Future scope (backlog):** Audio (.mp3, .wav — B52), Video (.mp4, .webm), Figma (.fig), Archives (.zip, .tar.gz).

---

## 9. Accessibility

| Concern             | Requirement                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| Image alt text      | AI-generated default on upload, user-editable. `alt=""` for decorative. |
| Lightbox            | Focus trap, Escape to close, `aria-label="Image viewer"`                |
| Code blocks         | Semantic `<pre><code>`, `aria-label` with language and line count       |
| PDF previews        | `alt` with page count                                                   |
| Tables (CSV)        | `<table>/<thead>/<th scope="col">`, `aria-label` with row/column count  |
| File action menus   | `role="menu"` + `role="menuitem"`, arrow key navigation, Escape closes  |
| Upload zone         | Keyboard-accessible "Browse files" alongside drag-drop                  |
| Upload progress     | `aria-live="polite"` region with file name and percentage               |
| Error messages      | `aria-describedby` linked to input                                      |
| Syntax highlighting | WCAG 2.2 AA contrast ratios (4.5:1) for all token colors                |

---

## 10. Chat Freeze Prevention Checklist

Derived from the dev diary's analysis (443 commits, 2.8:1 fix-to-feat ratio) and both reviews:

| #   | Scenario                             | Prevention                                         |
| --- | ------------------------------------ | -------------------------------------------------- |
| 1   | 5 images dropped at once             | Web Worker encoding + per-file progress            |
| 2   | Large file send                      | Separate upload endpoint, <1KB message payload     |
| 3   | Corrupt PDF uploaded                 | 30s processing timeout, `file_error` emitted       |
| 4   | 12000x8000 image pasted              | `OffscreenCanvas` in Worker                        |
| 5   | Session resume with content blocks   | `normalizeContent()` type narrowing                |
| 6   | New SSE events emitted               | All types in Zod schema before emission            |
| 7   | File "in context" but LLM cannot see | File preamble in system prompt, not sliding window |
| 8   | Upload before session loads          | Queue uploads, show "connecting..." state          |
| 9   | `refreshSession` during stream       | Metadata-only refresh, not full loadSession        |
| 10  | `file_processed` after `done`        | Handle file events regardless of chat state        |
| 11  | Phase transition + upload race       | File preamble auto-includes in new phase           |
| 12  | Processing error not caught          | Global 60s streaming timeout, forced idle          |

---

## 11. Competitive Differentiators

| Area                 | Competitors                | Arch                                         |
| -------------------- | -------------------------- | -------------------------------------------- |
| Error handling       | Universally weak           | 12-class taxonomy with recovery actions      |
| File persistence     | Images break, files lost   | Metadata-preserved references after deletion |
| Context transparency | Only Bolt shows usage      | Real-time token gauge per file               |
| Provider awareness   | Single-provider assumption | Capability-gated with graceful fallback      |
| File renderers       | Files as inputs only       | Rich per-type renderers with action menus    |
| BUILD integration    | Cursor/Replit have trees   | Upload to tree to Monaco to context pipeline |
| Smart routing        | None                       | OpenAPI import, ABL compile, CSV schema      |
| Accessibility        | Undocumented               | WCAG 2.2 AA from day one                     |

---

## 12. Post-Implementation Notes (2026-04-05)

Implementation of Phases 0-3 is complete (10 commits, 16 new files, ~52 files touched, 3 packages: arch-ai, database, studio). Phase 4 (smart routing) deferred to a separate ticket.

### Deviations from HLD

| Area                     | HLD Design                                  | Actual Implementation                                                                  | Reason                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package exports          | Standard package exports                    | Subpath exports (`./types`, `./session`, `./executor`) added to arch-ai `package.json` | Prevents Next.js client bundle from pulling server-only dependencies (fs, crypto, mongoose). Without subpath exports, client-side imports of content-blocks.ts would transitively import Node.js modules and fail in the browser. |
| Vision capability source | Direct `ModelCapabilities` compiler import  | `ContextCapabilities` interface used in arch-ai                                        | Keeps arch-ai independent of the compiler package. Vision capability passed in from the route layer rather than imported directly.                                                                                                |
| SVG sanitization         | DOMPurify on both client and server (FR-25) | Deferred                                                                               | DOMPurify dependency not added. SVG files are accepted but not sanitized against XSS. To be addressed before BETA.                                                                                                                |

### Implementation Scope

- **Implemented (Phases 0-3):** Upload endpoint, SessionFileStore, ArchContentBlock types, normalizeContent, content-block-resolver (provider-aware vision), Web Worker image resize, clipboard paste, file preamble injection, ContentBlockRenderer, ImageLightbox, FileContextMenu, TokenBudgetGauge, panel integrations
- **Deferred (Phase 4):** Smart routing (OpenAPI auto-import, ABL compile, CSV schema, PDF summarize) -- separate ticket
- **Not yet tested:** No E2E or integration test files written (deferred to BETA phase)
- **Pre-existing issue:** Next.js full build has async_hooks failure (not introduced by B03)

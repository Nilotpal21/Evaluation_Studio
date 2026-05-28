# Feature: B03 Multimodality Support

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `agent lifecycle`, `customer experience`
**Package(s)**: `arch-ai`, `database`, `studio`
**Owner(s)**: `Arch team`
**Testing Guide**: `../testing/arch-multimodality.md`
**Last Updated**: 2026-04-05

---

## 1. Introduction / Overview

### Problem Statement

Arch is text-only. Users cannot share screenshots, API specs, wireframes, data files, or reference documents with the AI architect. Every competitor (v0, Lovable, Bolt, Cursor, Windsurf, Devin, Replit Agent) supports multimodal file input. Without file upload, users must copy-paste content into chat, losing structure, metadata, and visual information. This is a table-stakes gap that blocks 7 downstream features (B19, B32, B33, B34, B35, B37, B48).

### Goal Statement

Enable users to share files and images with the Arch AI at any point in any phase (Interview, Blueprint, Build, Create) and in In-Project mode. Files become persistent session context that the LLM can reference across the conversation, with provider-aware vision support, rich per-type renderers, and IDE-grade file management in the BUILD phase.

### Summary

B03 adds multimodal file input to Arch across 4 tiers: basic file sharing (text files in any phase), image/screenshot support (paste, drag-drop, vision), persistent file context (session-scoped, cross-phase, sliding-window-safe), and smart file handling (OpenAPI auto-import, ABL compile, CSV schema analysis, PDF summarization). Files are uploaded via a separate endpoint, stored in a session-scoped `SessionFileStore` collection, and referenced by `blobId` in messages. The architecture uses content blocks (`ArchContentBlock`) instead of inline base64 to keep message payloads lightweight and files independently manageable.

---

## 2. Scope

### Goals

- File upload via drag-drop, file picker button, and clipboard paste (screenshots) in both onboarding chat and in-project overlay
- Support for images (PNG, JPEG, WebP, GIF, SVG), documents (PDF, DOCX, MD, TXT), data files (CSV, JSON, YAML), code files, OpenAPI specs, and ABL configs
- Provider-aware vision support with graceful degradation for non-vision models
- Session-scoped file persistence with cross-phase availability and sliding-window-safe context injection
- Rich per-type file renderers in chat messages (thumbnails, syntax preview, table preview, PDF badges)
- IDE-grade file management in BUILD phase (file tree, Monaco editing, context menu, delete/exclude)
- Smart file routing with auto-detect suggestions (OpenAPI import, ABL compile, CSV schema, PDF summarize)
- Token budget gauge showing per-file and total context cost
- 12-class error handling taxonomy with recovery actions for every failure mode
- WCAG 2.2 AA accessibility from day one

### Non-Goals (Out of Scope)

- Audio/video file support (deferred to B52 Full Media Support)
- Figma integration or design import
- Archive file extraction (.zip, .tar.gz)
- The `/api/arch-ai/chat` stateless route (all multimodal work targets `/api/arch-ai/message`)
- Project-level file persistence beyond session scope (files are session-scoped; relevant files copied to project on creation)
- Automatic re-send of old images when switching to a vision model

---

## 3. User Stories

1. As a **solution designer**, I want to drop an OpenAPI spec into the chat so that the AI can auto-generate tool definitions from my existing API.
2. As a **solution designer**, I want to paste a wireframe screenshot so that the AI can analyze UI components and suggest agent architecture based on the visual layout.
3. As a **solution designer**, I want to upload a compliance PDF so that the AI identifies constraints and flags them for the governance specialist.
4. As a **solution designer**, I want to see all my uploaded files in a file panel with context budget indicators so that I understand how much LLM context my files consume.
5. As a **solution designer**, I want uploaded files to persist across the sliding conversation window so that the AI doesn't lose file context after 8 messages.
6. As a **solution designer**, I want to upload reference YAML files into the BUILD file tree and edit them in Monaco so that I can iterate on agent configurations alongside generated files.
7. As a **solution designer**, I want clear error messages with recovery actions when file uploads fail so that I know exactly what went wrong and how to fix it.
8. As a **solution designer**, I want the system to gracefully handle non-vision models by attaching image metadata as text fallback so that files remain useful in the workspace even without vision analysis.
9. As a **solution designer**, I want to exclude files from AI context without deleting them so that I can manage token budget while keeping files accessible in the workspace.
10. As a **solution designer**, I want smart suggestions when uploading specific file types (OpenAPI, ABL, CSV, PDF) so that the AI proactively offers relevant actions.

---

## 4. Functional Requirements

1. **FR-1**: The system must accept file uploads via drag-drop onto the chat area, a file picker button in the chat input, and clipboard paste (Cmd+V / Ctrl+V for screenshots) in both the onboarding `/arch` page and the in-project `ArchOverlay`.
2. **FR-2**: The system must support the following file types: PNG, JPEG, WebP, GIF, SVG (images); PDF, DOCX, MD, TXT (documents); CSV, JSON, YAML (data); JS, TS, PY, GO, RS, RB, Java, SQL (code); OpenAPI specs; ABL configs.
3. **FR-3**: The system must enforce size limits: 10MB per file, 10 text files + 5 images per message, 50MB total per session, 8000x8000px max image dimensions with auto-resize above 1568px.
4. **FR-4**: The system must upload files via a separate `POST /api/arch-ai/files` endpoint (per-file, with progress reporting) and reference them by `blobId` in the message request, keeping message payloads under 1KB.
5. **FR-5**: The system must store uploaded files in a `SessionFileStore` MongoDB collection with session-scoped lifecycle, SHA-256 dedup, and tenant isolation.
6. **FR-6**: The system must persist messages containing files as `ArchContentBlock[]` (union of `text`, `image_ref`, `file_ref`, `tool_use`, `tool_result` blocks) in `StoredMessage.content`.
7. **FR-7**: The system must provide a `normalizeContent()` helper that type-narrows `string | ArchContentBlock[]` at every read site, ensuring backward compatibility with existing text-only sessions.
8. **FR-8**: The system must inject active files as a system prompt preamble (outside the sliding conversation window) so that file context persists beyond the 8-message window boundary.
9. **FR-9**: The system must gate image vision analysis on the active model's `supportsVision` capability via the platform's `ModelCapabilities` registry and convert image blocks to provider-specific formats (Anthropic, OpenAI, Google).
10. **FR-10**: The system must gracefully degrade for non-vision models by sending image metadata as text (`[Image: name, dimensions, type — vision analysis unavailable]`) and displaying an amber warning banner with a model switch option.
11. **FR-11**: The system must auto-detect and mark failed images (`status: 'failed'`) when the LLM returns a 400 error, automatically retry the same message without the failed image, and skip failed images in all future messages.
12. **FR-12**: The system must resize images larger than 1568px on the longest edge using `OffscreenCanvas` in a Web Worker (no main thread freeze) and encode to base64 in the Web Worker.
13. **FR-13**: The system must display file badges in chat messages: thumbnails (max 200px width) for images, type icon + filename + size for documents, syntax-highlighted 6-line preview for code files, table preview (3 rows) for CSV, page count badge for PDF.
14. **FR-14**: The system must provide a lightbox modal for full-resolution image viewing with focus trap, Escape to close, and `aria-label="Image viewer"`.
15. **FR-15**: The system must display uploaded files in the IDEPanel file tree under a new UPLOADS group (BUILD phase) with type badges, size, and context inclusion status (active/excluded/evicted/deleted/failed).
16. **FR-16**: The system must display uploaded files in the SpecificationCard under an "Attached Files" collapsible section (INTERVIEW/BLUEPRINT phases).
17. **FR-17**: The system must show a token budget gauge (used/total tokens with color coding: green <70%, amber 70-90%, red >90%) in the IDEPanel header and SpecificationCard attached files section.
18. **FR-18**: The system must provide a per-type context menu for files: View, Copy, Download, Edit in Monaco (text files), Import as Tools (OpenAPI), Compile (ABL), Exclude from Context, Replace, Delete (with confirmation).
19. **FR-19**: The system must support file editing via Monaco for text-based uploaded files in BUILD phase, with changes updating the LLM context.
20. **FR-20**: The system must correctly restore file-carrying messages on session resume: re-render file badges, lazy-load thumbnails, rebuild file tree, recalculate context budget, show "unavailable" badges for missing blobs.
21. **FR-21**: The system must emit 3 new SSE event types: `file_processed` (with metadata and optional `smartAction`), `file_error` (with error code, message, recovery actions), and `file_context_change` (with new status and budget).
22. **FR-22**: The system must handle `file_processed` events regardless of chat state (even after `done` event) to prevent late file events from being silently dropped.
23. **FR-23**: The system must auto-detect OpenAPI specs, ABL YAML configs, CSV files with headers, and PDFs with more than 5 pages, and offer smart action suggestions (Import Tools, Compile, Analyze Schema, Summarize) via the `file_processed.smartAction` field.
24. **FR-24**: The system must reject unsupported file types (.exe, .dll, .bin) with a clear error listing supported types, and reject empty files (0 bytes) with a specific message.
25. **FR-25**: The system must sanitize SVG files with DOMPurify on both client (before render) and server (before store) to prevent XSS.
26. **FR-26**: The system must handle duplicate filenames with a three-option dialog: Replace, Keep Both (auto-rename), Cancel. Content dedup uses SHA-256 hash (same content = silent reuse).
27. **FR-27**: The system must strip EXIF data from uploaded images on the server.
28. **FR-28**: The system must validate files server-side by verifying magic bytes match the claimed MIME type.
29. **FR-29**: The system must apply per-type processing timeouts: images 10s, CSV 10s, code 5s, DOCX 15s, OpenAPI 15s, PDF 30s. On timeout, return partial metadata with `processingIncomplete` flag.
30. **FR-30**: The system must display per-file upload progress bars during `POST /api/arch-ai/files` requests.
31. **FR-31**: The system must evict files from context when the token budget is exceeded, following eviction order: oldest messages first, then oldest files from preamble, with images evicted before text files.
32. **FR-32**: The system must notify users of context changes via `file_context_change` SSE events and update file panel indicators in real time.
33. **FR-33**: The system must handle clipboard paste events by checking `clipboardData.items` for `image/*` MIME types, creating a synthetic `File("screenshot-{timestamp}.png")`, and routing through the standard upload pipeline. Non-image paste is silently ignored.
34. **FR-34**: The system must prevent browser navigation on file drop in the ArchOverlay by adding `onDragOver`/`onDrop` `preventDefault` handlers to the overlay container.
35. **FR-35**: The system must support file exclusion from AI context (file stays in workspace but not sent to LLM) and re-inclusion, with visual indicators (green checkmark for included, gray circle for excluded).

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                               |
| -------------------------- | ------------ | ------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Files copied to project assets on creation                          |
| Agent lifecycle            | PRIMARY      | Files provide context for agent design across all phases            |
| Customer experience        | PRIMARY      | Core UX improvement enabling multimodal interaction                 |
| Integrations / channels    | NONE         | Arch-specific, not channel-facing                                   |
| Observability / tracing    | SECONDARY    | File processing events emitted via SSE, file errors tracked         |
| Governance / controls      | SECONDARY    | File type validation, size limits, SVG sanitization, EXIF stripping |
| Enterprise / compliance    | SECONDARY    | Tenant isolation on file storage, session-scoped lifecycle          |
| Admin / operator workflows | NONE         | No admin-facing changes                                             |

### Related Feature Integration Matrix

| Related Feature                                                                 | Relationship Type | Why It Matters                                                                              | Key Touchpoints                                      | Current State  |
| ------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------- |
| B02 (Page Context)                                                              | shares data with  | Context enrichment pattern is shared                                                        | System prompt preamble injection                     | Implemented    |
| B05 (Live Thinking Visibility)                                                  | shares data with  | Activity SSE events share the same protocol                                                 | SSE schema, `useArchChat` switch block               | Implemented    |
| B19 (Programmatic UI Control)                                                   | depends on B03    | Screenshot proof requires image in chat                                                     | Image content blocks                                 | Blocked by B03 |
| B32 (Agent Personality Preview)                                                 | depends on B03    | Avatar images displayed inline                                                              | Image rendering pipeline                             | Blocked by B03 |
| B33 (Conversation Replay Theater)                                               | depends on B03    | Animated replay screenshots                                                                 | Image storage and rendering                          | Blocked by B03 |
| B34 (Impact Dashboard)                                                          | depends on B03    | Visual diff screenshots                                                                     | Image content blocks                                 | Blocked by B03 |
| B35 (Onboarding Tutorial)                                                       | depends on B03    | Visual step screenshots                                                                     | Image rendering pipeline                             | Blocked by B03 |
| B37 (Design Critique)                                                           | depends on B03    | Topology screenshots annotated with critique                                                | Image storage, vision analysis                       | Blocked by B03 |
| B48 (Incident Replay)                                                           | depends on B03    | Error screenshots from users as input                                                       | Image upload, vision analysis                        | Blocked by B03 |
| S1-F10 (Text File Upload)                                                       | extends           | B03 implements and extends text file upload spec                                            | Upload pipeline, file badges, validation             | Implemented    |
| S1-F11 (Image Upload with Vision)                                               | extends           | B03 implements and extends image upload spec                                                | Vision pipeline, thumbnail rendering, lightbox       | Implemented    |
| S2-F12 (API Spec Import)                                                        | extends           | OpenAPI handling reusable for smart routing                                                 | Smart action: Import Tools                           | Spec only      |
| Unified Chat Footer (ChatInputBar)                                              | extends           | B03 adds paste/drag-drop/progress to the canonical component                                | `ChatInputBar.tsx`, `onSend`, file encoding flow     | Landed         |
| [Intelligent File Processing](sub-features/arch-intelligent-file-processing.md) | extends           | Adds prompt-driven intelligence for extracting, acknowledging, and acting on uploaded files | Prompts, `buildFilePreamble()`, `classifyFileType()` | PLANNED        |

---

## 6. Design Considerations

### Wireframes

- IDEPanel with UPLOADS group, token gauge, and context menu: design doc section 5.2
- SpecificationCard attached files section: design doc section 5.3
- Chat message file rendering (thumbnails, badges, syntax preview): design doc section 5.4
- File action context menu per type: design doc section 5.5
- File status indicators (active, excluded, evicted, deleted, failed): design doc section 6.1-6.2
- File tree structure in BUILD phase: research doc section 7.1

### Accessibility

| Concern             | Requirement                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| Image alt text      | AI-generated default on upload, user-editable. `alt=""` for decorative.    |
| Lightbox            | Focus trap, Escape to close, `aria-label="Image viewer"`                   |
| Code blocks         | Semantic `<pre><code>`, `aria-label` with language and line count          |
| PDF previews        | `alt` with filename, page number, and total pages                          |
| Tables (CSV)        | `<table>/<thead>/<th scope="col">`, `aria-label` with row and column count |
| File action menus   | `role="menu"` + `role="menuitem"`, arrow key navigation, Escape closes     |
| Upload zone         | Keyboard-accessible "Browse files" alongside drag-drop                     |
| Upload progress     | `aria-live="polite"` announcing upload percentage                          |
| Error messages      | `aria-describedby` linked to input                                         |
| Syntax highlighting | WCAG 2.2 AA contrast (4.5:1)                                               |

---

## 7. Technical Considerations

### Architecture: Hybrid C (Content Blocks + External Blobs, Provider-Aware)

Messages store lightweight `blobId` references, not inline base64. Files are uploaded separately to `POST /api/arch-ai/files`, stored in `SessionFileStore`, and resolved at LLM call time. This prevents main-thread freezes (68MB base64 strings), enables per-file progress, and keeps message payloads under 1KB.

### Critical Migration: StoredMessage.content

`StoredMessage.content` changes from `string` to `string | ArchContentBlock[]`. This touches 10 consumers across TypeScript types, Mongoose schema, route handlers, LLM message builders, client message types, session restore, executor interfaces, SSE handlers, and chat renderers. The migration must be atomic in one vertical slice with `normalizeContent()` at every read site. See the Content Migration Matrix (design doc section 13) for the complete inventory.

### Provider-Aware Pipeline

The platform's `ModelCapabilities` registry already tracks `supportsVision`, `contextWindow`, and provider per model. The executor resolves `ArchContentBlock[]` to provider-specific `ProviderContentBlock[]` at LLM call time, converting `image_ref` blocks to Anthropic, OpenAI, or Google format.

### File Preamble (Sliding Window Fix)

Active files are injected as a system prompt preamble, outside the sliding conversation window. This prevents the trust-damaging bug where a file attached to message 1 is lost from LLM context by message 9 while the file panel still shows "in context."

### Prerequisites (Hard Blockers)

1. SSE schema alignment (add B03 events, remove dead spec types)
2. StoredMessage content migration inventory (type changes + normalizeContent at all read sites)
3. ArchOverlay drag-drop prevention (browser navigation fix)
4. Canonical UI entry point wiring (RESOLVED by unified chat input work)
5. Research/design doc consistency (SUPERSEDED banner, authoritative pointer)

---

## 8. How to Consume

### Studio UI

**Onboarding (`/arch` page):**

- Drag-drop files onto chat area or click attachment button in ChatInputBar
- Paste screenshots via Cmd+V / Ctrl+V
- File badges appear in sent messages
- Uploaded files shown in SpecificationCard "Attached Files" section (INTERVIEW/BLUEPRINT)
- Uploaded files shown in IDEPanel UPLOADS group (BUILD)
- Token budget gauge visible in IDEPanel header and SpecificationCard

**In-Project (ArchOverlay):**

- Same file upload capabilities via ChatInputBar (compact variant)
- Files available for in-project specialist context

### API (Studio)

| Method | Path                   | Purpose                                               |
| ------ | ---------------------- | ----------------------------------------------------- |
| POST   | `/api/arch-ai/files`   | Upload a single file, returns `blobId` and metadata   |
| POST   | `/api/arch-ai/message` | Send message with `fileRefs: [{ blobId }]` references |

### Admin Portal

N/A -- no admin-facing changes.

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. B03 is specific to the Arch AI Studio experience.

---

## 9. Data Model

### Collections / Tables

```text
Collection: SessionFileStore (NEW)
Fields:
  - _id: string (blobId, uuidv7)
  - sessionId: string (FK to ArchSession)
  - tenantId: string (required, indexed — tenant isolation)
  - name: string (original filename)
  - mediaType: string (MIME type)
  - size: number (bytes)
  - hash: string (SHA-256 for dedup)
  - content: Buffer (file bytes; GridFS ref for >4MB)
  - metadata:
    - width?: number (images only)
    - height?: number (images only)
    - pageCount?: number (PDFs)
    - lineCount?: number (text files)
    - language?: string (detected code language)
    - endpointCount?: number (OpenAPI specs)
    - columns?: string[] (CSV headers)
    - rowCount?: number (CSV)
    - tokenEstimate: number (estimated LLM tokens)
  - phase: string (phase when uploaded)
  - status: 'active' | 'excluded' | 'evicted' | 'deleted' | 'failed'
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { sessionId, status }  — primary query pattern
  - { sessionId, hash }    — dedup lookup
  - { tenantId, sessionId } — tenant isolation
```

### ArchContentBlock Type

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

### StoredMessage Migration

```typescript
// Before
content: string;

// After
content: string | ArchContentBlock[];
```

### FilePanelFile Extension

```typescript
interface FilePanelFile {
  // ... existing fields
  fileType?: 'agent' | 'mock' | 'upload'; // NEW: 'upload' type
  upload?: {
    blobId: string;
    mediaType: string;
    size: number;
    width?: number;
    height?: number;
    tokenCost: number;
    inContext: boolean;
    preview?: string; // thumbnail data URL for images
  };
}
```

### Key Relationships

- `SessionFile.sessionId` references `ArchSession._id`
- `ArchContentBlock.image_ref.blobId` and `file_ref.blobId` reference `SessionFile._id`
- On project creation, active `SessionFile` records are copied to project asset store
- `SessionFile` lifecycle is tied to session lifecycle (session end = cleanup eligible)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                   | Purpose                                             |
| ------------------------------------------------------ | --------------------------------------------------- |
| `packages/arch-ai/src/types/content-blocks.ts`         | NEW: ArchContentBlock union type + normalizeContent |
| `packages/arch-ai/src/types/session.ts`                | StoredMessage.content migration to union type       |
| `packages/arch-ai/src/types/sse-events.ts`             | Add file_processed, file_error, file_context_change |
| `packages/arch-ai/src/executor/specialist-executor.ts` | Accept string or ProviderContentBlock[] in messages |
| `packages/arch-ai/src/executor/multi-turn-executor.ts` | MultiTurnMessage.content migration                  |
| `packages/arch-ai/src/session/`                        | NEW: File store service, dedup, metadata extraction |

### Routes / Handlers

| File                                               | Purpose                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/studio/src/app/api/arch-ai/files/route.ts`   | NEW: Upload endpoint, returns blobId + metadata                   |
| `apps/studio/src/app/api/arch-ai/message/route.ts` | Build ArchContentBlock[] from text + fileRefs, LLM builder update |

### UI Components

| File                                                                     | Purpose                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| `apps/studio/src/hooks/useArchChat.ts`                                   | SSE handlers for file events, session restore, rawContent |
| `apps/studio/src/components/arch-v3/chat/ChatInputBar.tsx`               | Add paste handler, drag-drop zone, progress, warning      |
| `apps/studio/src/components/arch-v3/chat/FileAttachment.tsx`             | Validation logic, encoding utilities                      |
| `apps/studio/src/components/arch-v3/panels/IDEPanel.tsx`                 | UPLOADS group, context menu, token gauge                  |
| `apps/studio/src/components/arch-v3/specification/SpecificationCard.tsx` | Attached Files collapsible section                        |
| `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx`  | upload_file tab type                                      |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`             | Drag-drop prevention, file attachment wiring              |
| `apps/studio/src/app/arch/page.tsx`                                      | Replace encodeFilesForRequest with upload-then-ref        |
| `apps/studio/src/store/arch-ai-store.ts`                                 | FilePanelFile extension, file SSE event handlers          |

### Backend / Data

| File                                                 | Purpose                                       |
| ---------------------------------------------------- | --------------------------------------------- |
| `packages/database/src/models/`                      | NEW: SessionFile model + indexes              |
| `packages/database/src/models/arch-session.model.ts` | content field migration to Schema.Types.Mixed |

### New Files Created During Implementation

| File                                                               | Purpose                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `packages/arch-ai/src/types/content-blocks.ts`                     | ArchContentBlock, ProviderContentBlock, normalizeContent |
| `packages/arch-ai/src/session/file-store-service.ts`               | FileStoreService (store, dedup, metadata)                |
| `packages/arch-ai/src/executor/content-block-resolver.ts`          | resolveContentBlocks, buildFilePreamble                  |
| `packages/database/src/models/session-file.model.ts`               | SessionFile Mongoose model + indexes                     |
| `apps/studio/src/app/api/arch-ai/files/route.ts`                   | Upload endpoint (POST, returns blobId)                   |
| `apps/studio/src/lib/arch/upload-files.ts`                         | Client-side upload utility                               |
| `apps/studio/public/workers/image-resize.worker.js`                | Web Worker for OffscreenCanvas resize                    |
| `apps/studio/src/components/arch-v3/chat/ContentBlockRenderer.tsx` | Per-type content block renderer                          |
| `apps/studio/src/components/arch-v3/chat/ImageLightbox.tsx`        | Full-resolution image lightbox modal                     |
| `apps/studio/src/components/arch-v3/panels/FileContextMenu.tsx`    | Per-type file context menu                               |
| `apps/studio/src/components/arch-v3/panels/TokenBudgetGauge.tsx`   | Token budget gauge component                             |

### Tests

| File | Type        | Coverage Focus                                 | Status     |
| ---- | ----------- | ---------------------------------------------- | ---------- |
| TBD  | e2e         | Upload pipeline, session resume, vision gating | NOT TESTED |
| TBD  | integration | Content block persistence, normalizeContent    | NOT TESTED |
| TBD  | unit        | File validation, token estimation, dedup       | NOT TESTED |

> **Note (2026-04-05):** No test files have been written yet. Tests are deferred to BETA phase (require running MongoDB + server).

---

## 11. Configuration

### Environment Variables

No new environment variables required. B03 uses existing platform configuration for model capabilities and database connections.

### Runtime Configuration

| Setting                | Default            | Description                                   |
| ---------------------- | ------------------ | --------------------------------------------- |
| Max file size          | 10MB               | Per-file upload limit                         |
| Max files per message  | 10 text + 5 images | Per-message file count limits                 |
| Max session storage    | 50MB               | Total file storage per session                |
| Image resize threshold | 1568px             | Auto-resize images above this on longest edge |
| Text truncation limit  | 50K chars          | Max characters before truncation with note    |
| Image max dimensions   | 8000x8000px        | Hard limit, reject above                      |

### DSL / Agent IR / Schema

N/A -- B03 operates at the Arch AI orchestration layer, not the agent DSL layer.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Project isolation | SessionFileStore is session-scoped; files are not shared across sessions or projects. Files copied on project creation. |
| Tenant isolation  | Every SessionFileStore query includes `tenantId`. Cross-tenant file access returns 404.                                 |
| User isolation    | Files are owned by the session creator. No cross-user file access.                                                      |

### Security & Compliance

- SVG sanitization via DOMPurify on both client and server (defense in depth)
- EXIF data stripped from uploaded images
- Magic bytes validation: server verifies file content matches claimed MIME type
- No executable file types accepted (.exe, .dll, .bin rejected)
- Base64 encoding/decoding validated server-side
- File content stored in session-scoped collection with TTL aligned to session lifecycle

### Performance & Scalability

- Upload-then-reference architecture: message payloads stay under 1KB (blobId references only)
- Web Worker for base64 encoding and OffscreenCanvas image resize (no main-thread freeze)
- Per-type processing timeouts (5s-30s) prevent server hangs on corrupt files
- Lazy loading for thumbnails and file previews via IntersectionObserver
- Monaco editor lazy-loaded only on "Edit" click (~2MB bundle)
- Virtual scroll for large CSV tables and long text files (>10K lines)
- SHA-256 dedup prevents redundant storage of identical content

### Reliability & Failure Modes

The system uses a 12-class error handling taxonomy across 4 layers:

**Client-side validation (6 classes):** File too large, unsupported type, too many files, image oversized (auto-resize), empty file, model vision check.

**Server-side validation (6 classes):** Corrupt image, PDF parse failure, DOCX parse failure, base64 decode failure, invalid OpenAPI spec, magic bytes mismatch.

**Runtime errors (4 classes):** Context window exceeded, LLM image rejection, LLM timeout with images, network failure mid-upload.

**State errors (3 classes):** Session resume with missing file, duplicate filename, storage quota exceeded.

Every error class has a specific user message and recovery action (retry, remove, replace, switch model). Failed images are auto-skipped in future messages to prevent the unrecoverable session bug known from Claude Code.

### Observability

- 3 new SSE event types: `file_processed`, `file_error`, `file_context_change`
- Token budget gauge provides real-time context usage visibility
- File status state machine tracks transitions: active -> excluded/evicted/deleted/failed
- Processing timeouts logged with partial metadata flag

### Data Lifecycle

- Files are session-scoped: cleanup eligible when session ends
- Session-per-file limits: 10MB per file, 50MB per session
- Eviction order when context budget exceeded: oldest messages first, then oldest files, images before text files
- Deleted files preserved as metadata-only references in chat history (name, size, type visible; content removed)
- Relevant files copied to project asset store on project creation

---

## 13. Delivery Plan / Work Breakdown

1. **Phase 0: Prerequisites**
   1.1 Align SSE schema with protocol: add `file_processed`, `file_error`, `file_context_change` to Zod schema; remove dead spec types
   1.2 Prepare StoredMessage for content blocks: create `ArchContentBlock` type, add `normalizeContent()`, update all 10 read sites
   1.3 Fix ArchOverlay drag-drop browser navigation with preventDefault handlers
   1.4 Add authoritative-design pointer to research doc (resolve design/research conflicts)
   1.5 Exit criteria: SSE schema validates all event types; no feature code; text-only sessions unaffected

2. **Phase 1: Upload Endpoint + SessionFileStore + Content Blocks (Text Files Only)**
   2.1 Add SessionFile model + indexes to `packages/database`
   2.2 Add `POST /api/arch-ai/files` upload endpoint (validation, metadata extraction, dedup)
   2.3 Add ArchContentBlock types and normalizeContent helper to `packages/arch-ai`
   2.4 Wire content blocks through route handler (build ArchContentBlock[] from text + fileRefs)
   2.5 Add file preamble injection in system prompt (outside sliding window)
   2.6 Add `fileRefs` field to MessageRequest and update both route paths
   2.7 Add per-type processing timeouts (5-30s)
   2.8 Replace `encodeFilesForRequest()` with upload-then-reference flow in both surfaces
   2.9 Exit criteria: upload YAML -> stored -> message persists with content blocks -> LLM sees file -> session resume works -> sliding window preserves file context

3. **Phase 2: Image Upload + Vision**
   3.1 Add Web Worker image resize (OffscreenCanvas) + base64 encoding
   3.2 Add provider-aware vision capability gating via ModelCapabilities
   3.3 Add provider-specific format conversion (Anthropic, OpenAI, Google)
   3.4 Add graceful degradation for non-vision models (text fallback + amber warning)
   3.5 Add failed image auto-skip in executor (status: 'failed', auto-retry without image)
   3.6 Add clipboard paste handler (Cmd+V screenshot capture)
   3.7 Add SVG sanitization (DOMPurify client + server)
   3.8 Exit criteria: paste screenshot -> resized -> uploaded -> vision model analyzes -> non-vision gets text fallback -> bad image doesn't brick session -> session resume shows thumbnails

4. **Phase 3: UI Integration**
   4.1 Add UPLOADS group to IDEPanel file tree with type badges and status indicators
   4.2 Add "Attached Files" collapsible section to SpecificationCard
   4.3 Wire FileAttachment to ArchOverlay in-project surface
   4.4 Add token budget gauge (IDEPanel header + SpecificationCard)
   4.5 Add per-type file context menu with filtered actions
   4.6 Add chat message file renderers (thumbnails, syntax preview, table preview, PDF badge)
   4.7 Add lightbox modal for images
   4.8 Add upload progress bar (per-file)
   4.9 Add `upload_file` tab type to OnboardingArtifactPanel
   4.10 Exit criteria: full visual experience -- file tree, token gauge, context menu, lightbox, deleted file badges, progress bar all working

5. **Phase 4: Smart Routing (Tier 4)**
   5.1 Add OpenAPI auto-detect + "Import as tools?" suggestion
   5.2 Add ABL YAML auto-detect + "Compile?" suggestion
   5.3 Add CSV schema analysis suggestion
   5.4 Add PDF summarization offer (>5 pages)
   5.5 Render `file_processed.smartAction` suggestions in chat
   5.6 Exit criteria: upload OpenAPI spec -> suggestion appears -> user clicks -> tools imported; same for ABL, CSV, PDF

---

## 14. Success Metrics

| Metric                        | Baseline | Target | How Measured                                            |
| ----------------------------- | -------- | ------ | ------------------------------------------------------- |
| File upload adoption          | 0%       | >50%   | % of Arch sessions with at least one file upload        |
| Upload success rate           | N/A      | >95%   | Successful uploads / total upload attempts              |
| Vision analysis usage         | 0%       | >30%   | % of image uploads that trigger vision analysis         |
| Context budget transparency   | None     | Always | Token gauge visible whenever files are attached         |
| Session resume file integrity | N/A      | 100%   | Files correctly restored on resume (no [object Object]) |
| Smart routing engagement      | N/A      | >40%   | % of smart action suggestions accepted by users         |
| Error recovery rate           | N/A      | >80%   | % of file errors resolved via provided recovery actions |

---

## 15. Open Questions

1. Should chunked uploads (tus protocol) be used for resilience, or is single-request viable given the 10MB limit? (The separate `/files` endpoint makes single-request viable since each file is its own POST with progress.)
2. Should BUILD phase track file versions (original -> modified) or just overwrite?
3. Should the specialist explicitly acknowledge each file upload, or silently incorporate file content?
4. Should auto-summarization be offered at 80% or 90% of the context budget?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                        | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Audio/video file support deferred to B52                                                                                           | Medium   | Open   |
| GAP-002 | Figma integration (design import) not in scope                                                                                     | Low      | Open   |
| GAP-003 | Archive extraction (.zip, .tar.gz) not in scope                                                                                    | Low      | Open   |
| GAP-004 | `/api/arch-ai/chat` stateless route not updated for multimodal (all work targets `/api/arch-ai/message`)                           | Medium   | Open   |
| GAP-005 | No automatic re-send of old images when switching from non-vision to vision model (user must manually re-attach)                   | Low      | Open   |
| GAP-006 | MongoDB 16MB document limit requires GridFS for files > 4MB (per LLD decision D4); GridFS integration complexity not fully scoped  | High     | Open   |
| GAP-007 | File versioning in BUILD (track original vs modified) unresolved                                                                   | Medium   | Open   |
| GAP-008 | Specialist acknowledgment pattern for file uploads unresolved (explicit acknowledge vs silent incorporation)                       | Medium   | Open   |
| GAP-009 | Auto-summarization threshold (80% vs 90% budget) unresolved                                                                        | Low      | Open   |
| GAP-010 | `collect_file` widget coexistence: proactive upload auto-satisfies pending widget only if type matches; edge cases may need tuning | Medium   | Open   |
| GAP-011 | No E2E or integration tests written yet (ALPHA). Tests deferred to BETA phase (require running MongoDB + server).                  | High     | Open   |
| GAP-012 | SVG sanitization deferred -- DOMPurify dependency not added. SVG files accepted but not sanitized against XSS.                     | Medium   | Open   |
| GAP-013 | Phase 4 smart routing (OpenAPI auto-import, ABL compile, CSV schema, PDF summarize) deferred to separate ticket.                   | Medium   | Open   |
| GAP-014 | Pre-existing Next.js full build has async_hooks failure (not from B03, but affects CI pipeline).                                   | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                 | Coverage Type | Status     | Test File / Note     |
| --- | ------------------------------------------------------------------------ | ------------- | ---------- | -------------------- |
| 1   | SSE parser accepts file_processed, file_error, file_context_change       | unit          | NOT TESTED | Phase 0 prerequisite |
| 2   | StoredMessage with content: string resumes correctly (backward compat)   | integration   | NOT TESTED | Phase 0 prerequisite |
| 3   | StoredMessage with content: ArchContentBlock[] resumes correctly         | integration   | NOT TESTED | Phase 0 prerequisite |
| 4   | File drop on ArchOverlay does NOT navigate browser                       | e2e           | NOT TESTED | Phase 0 prerequisite |
| 5   | POST file to /api/arch-ai/files returns blobId + metadata                | integration   | NOT TESTED | Phase 1              |
| 6   | Message with fileRef persists as ArchContentBlock[]                      | integration   | NOT TESTED | Phase 1              |
| 7   | Session resume with file message renders correctly (not [object Object]) | e2e           | NOT TESTED | Phase 1              |
| 8   | File preamble survives 8+ message sliding window                         | integration   | NOT TESTED | Phase 1              |
| 9   | LLM messages contain provider content blocks for file messages           | integration   | NOT TESTED | Phase 1              |
| 10  | Full Interview flow with file upload produces zero regression            | e2e           | NOT TESTED | Phase 1              |
| 11  | Paste 12000x8000 image resized in Worker without main thread freeze      | e2e           | NOT TESTED | Phase 2              |
| 12  | Image to non-vision model produces text fallback (not crash)             | integration   | NOT TESTED | Phase 2              |
| 13  | Image to Anthropic uses correct base64 format                            | integration   | NOT TESTED | Phase 2              |
| 14  | Corrupt image upload produces file_error and auto-skip in future         | integration   | NOT TESTED | Phase 2              |
| 15  | Cmd+V screenshot appears in attachment area                              | e2e           | NOT TESTED | Phase 2              |
| 16  | SVG with script tag sanitized by DOMPurify                               | unit          | NOT TESTED | Phase 2              |
| 17  | Uploaded file appears in IDEPanel UPLOADS group                          | e2e           | NOT TESTED | Phase 3              |
| 18  | Token budget gauge updates on file upload/delete                         | e2e           | NOT TESTED | Phase 3              |
| 19  | Image thumbnail click opens lightbox                                     | e2e           | NOT TESTED | Phase 3              |
| 20  | File delete shows "removed" badge in chat history                        | e2e           | NOT TESTED | Phase 3              |
| 21  | Upload OpenAPI spec triggers "Import as tools?" suggestion               | e2e           | NOT TESTED | Phase 4              |
| 22  | Upload ABL YAML triggers "Compile?" suggestion                           | e2e           | NOT TESTED | Phase 4              |

### Testing Notes

No tests have been written yet. Implementation of Phases 0-3 is complete (10 commits, 16 new files, ~52 files touched). The dev plan review (2026-04-05) defines a 42-test regression plan across all 4 phases plus prerequisites. All scenarios remain NOT TESTED. Test writing is deferred to the BETA phase (requires running MongoDB + Studio server).

> Full testing details: `../testing/arch-multimodality.md`

---

## 18. References

- Design doc: `docs/arch/research/2026-04-05-multimodality-design.md`
- Research doc: `docs/arch/research/2026-04-05-multimodality-research.md`
- Backlog item: `docs/arch/backlogs/B03-file-upload-enhancement.md`
- S1-F10 spec: `docs/arch/features/S1-F10-text-file-upload.md`
- S1-F11 spec: `docs/arch/features/S1-F11-image-upload-vision.md`
- Dev plan review: `docs/arch/research/2026-04-05-multimodality-dev-plan-review.md`
- Design reviews: `docs/arch/review/2026-04-05-claude-4.6-opus-multimodality-review.md`, `docs/arch/review/2026-04-05-gpt-5.4-codex-multimodality-review.md`

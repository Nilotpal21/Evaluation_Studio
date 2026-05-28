# File Upload Restoration — Design & Gap Analysis

## Executive Summary

During the KB navigation redesign, the old `DocumentsTab.tsx` (656 lines) was replaced
by the new `DataSection` component tree. The document list view was migrated to
`DocumentTable.tsx`, but the **file upload functionality was not migrated** — it was
gated behind "Coming Soon" instead. The backend is 100% functional. This document
describes exactly what needs to be restored and the user experience flow.

## What Was Lost

| Old Component      | What It Had                                                                                                                                      | New Replacement                              | What's Missing                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------- |
| `DocumentsTab.tsx` | File picker dropzone, source selector, metadata fields from canonical schema, upload hints (sticky fields), progress bar, inline source creation | `DocumentTable.tsx`                          | **All upload UI** — file picker, metadata form, progress, source selection |
| `api/search-ai.ts` | `uploadDocument()`, `fetchUploadHints()`, `UploadHintsResponse`, `UploadFieldHint` types                                                         | —                                            | **Both API functions and types deleted**                                   |
| Source creation    | Used `sourceType: 'manual'` → auto-creates ConnectorConfig                                                                                       | `AddSourceButton` sends `sourceType: 'file'` | **ConnectorConfig not created** → breaks upload hints                      |

## Backend Status (100% Complete — No Changes Needed)

| Component                | Status    | Location                                                                                                                   |
| ------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| Upload endpoint          | ✅        | `POST /api/indexes/:id/sources/:sourceId/documents` (document-upload.ts, 745 lines)                                        |
| Multer disk storage      | ✅        | 100MB limit, MIME validation, temp cleanup                                                                                 |
| SHA-256 dedup            | ✅        | Content hash, `force=true` to replace                                                                                      |
| MIME routing             | ✅        | PDF/DOCX→Docling, TXT/MD→Legacy, JSON→json-chunking, CSV/XLSX→structured                                                   |
| Storage layer            | ✅        | S3 + local filesystem (storage-factory.ts)                                                                                 |
| Upload hints API         | ✅        | `GET /api/indexes/:id/upload-hints` (sources.ts:190-244)                                                                   |
| Source auto-config       | ✅        | `sourceType: 'manual'` → auto-creates `ConnectorConfig` with `connectorType: 'file_upload'`                                |
| Sticky field persistence | ✅        | `ConnectorConfig.uploadFieldHints` updated after each upload                                                               |
| Next.js proxy route      | ⚠️ BROKEN | `proxyToSearchEngine` forces `JSON.stringify(body)` + `Content-Type: application/json` — destroys FormData. See T-0 below. |
| Upload hints proxy       | ✅        | No App Router route → falls through to middleware `NextResponse.rewrite()` (transparent proxy)                             |
| Pipeline workers         | ✅        | Docling extraction → page processing → chunking → embedding → indexed                                                      |

## Canonical Schema Integration (How Metadata Fields Work)

The upload hints system ties into the **3-layer schema architecture**:

```
Layer 1: Source Schema (per connector)     → DiscoveredSchema / ConnectorSchema
Layer 2: Canonical Schema (per KB)         → CanonicalSchema (75+ pre-defined slots)
Layer 3: Domain Vocabulary (per KB)        → DomainVocabulary (natural-language terms)
```

### Upload Hints Flow

```
User opens upload dialog
  → GET /indexes/:id/upload-hints
    → Finds all ConnectorConfigs with connectorType: 'file_upload' for this index
    → Returns:
        recentFields: string[]              ← storageField keys from last upload
        lastValues: Record<string, string>  ← last entered values (used as placeholders)
        allFields: AvailableCanonicalField[] ← core + common canonical fields

User fills metadata fields and uploads file
  → POST /indexes/:id/sources/:sourceId/documents (multipart)
    → Metadata stored under sourceMetadata.file_upload.*
    → ConnectorConfig.uploadFieldHints updated with { recentFields, lastValues, updatedAt }
    → Next upload shows previously-used fields first with last values as placeholders
```

### Available Fields

| Category                     | Count | Examples                                                                     |
| ---------------------------- | ----- | ---------------------------------------------------------------------------- |
| Core (always shown)          | 12    | title, content_summary, source_type, source_url, author, language, category  |
| Common (expandable)          | 26    | description, tags, priority, assignee, reporter, department, version         |
| Custom slots (advanced JSON) | 40    | custom_string_1..20, custom_number_1..10, custom_date_1..5, custom_bool_1..5 |

Fields render with **dynamic input types**:

- `date` → `<input type="date">`
- `float` / `integer` → `<input type="number">`
- everything else → `<input type="text">`

## User Experience — Designed Flow

### Flow 1: First-Time File Upload (No Sources Yet)

```
┌──────────────────────────────────────────────────┐
│  Data Section                                     │
│  ┌──────────────────────────────────────────────┐ │
│  │ [All] [file] [web] [db] [api]    [+ Add Source]│ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │        📄 No documents yet                    │ │
│  │   Upload files to populate this index         │ │
│  │   [Upload Files]                              │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

User clicks **"+ Add Source"** → Type grid dialog:

```
┌─────────────────────────────────────┐
│  Add Source                          │
│                                      │
│  ┌──────────┐  ┌──────────────────┐ │
│  │ 📁 File  │  │ 🌐 Web Crawl    │ │
│  │ Upload   │  │    Coming Soon   │ │
│  └──────────┘  └──────────────────┘ │
│  ┌──────────┐  ┌──────────────────┐ │
│  │ 🗄️ DB   │  │ 🔌 API          │ │
│  └──────────┘  └──────────────────┘ │
│  ┌──────────────────────────────────┐│
│  │ 🏢 SharePoint       Enterprise  ││
│  └──────────────────────────────────┘│
└─────────────────────────────────────┘
```

User clicks **"File Upload"** → **Step 2: File Upload Dialog** (replaces current config form):

```
┌───────────────────────────────────────────────────┐
│  Upload Files                                      │
│                                                     │
│  Source Name: [Manual Uploads_______________]       │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │                                             │   │
│  │    📤 Click to select files or drag & drop  │   │
│  │    PDF, DOCX, PPTX, HTML, TXT, MD,         │   │
│  │    JSON, CSV, XLSX (max 100MB each)         │   │
│  │                                             │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  📄 report-q1.pdf                    12.3 MB  [✕]  │
│  📄 product-spec.docx                2.1 MB  [✕]  │
│                                                     │
│  ── Metadata Fields ──────────────────────────────  │
│  Author:   [____________]  Category: [__________]   │
│  Tags:     [____________]  Dept:     [__________]   │
│                                                     │
│  ▸ More Fields (22)                                 │
│  ▸ Advanced (custom JSON)                           │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ Uploading... report-q1.pdf        ████░ 80% │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│                          [Cancel]  [Upload 2 Files] │
└───────────────────────────────────────────────────┘
```

### Flow 2: Upload to Existing Source

User clicks **upload icon** (📤) on an existing file source row in SourceFilterBar,
OR an **"Upload Files"** button in the DocumentTable when filtered to a file source:

```
┌───────────────────────────────────────────────────┐
│  Upload Files to "Manual Uploads"                  │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │    📤 Click to select files or drag & drop  │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ── Previously Used Fields ───────────────────────  │
│  Author:   [Jane Doe____]  Category: [Research__]   │
│  Tags:     [Q1, 2026____]  Dept:     [Eng_______]   │
│                                                     │
│  ▸ More Fields (22)                                 │
│  ▸ Advanced (custom JSON)                           │
│                                                     │
│                              [Cancel]  [Upload]     │
└───────────────────────────────────────────────────┘
```

Note: **Previously Used Fields** shows the fields from the last upload with their
last values as placeholders (from `uploadFieldHints.lastValues`). This is the
"sticky field" UX from the canonical schema integration.

### Flow 3: Empty State Upload Shortcut

When DocumentTable has no documents, the empty state shows an **"Upload Files"** button
that opens the upload dialog directly (auto-creates a "Manual Uploads" source if none exists).

## Implementation Tasks

### T-0: Fix Upload Proxy Route (CRITICAL — Blocker)

**Problem:** The App Router route at `apps/studio/src/app/api/search-ai/indexes/[id]/sources/[sourceId]/documents/route.ts`
calls `proxyToSearchEngine(request, path, { body: formData })`. But `proxyToSearchEngine` →
`proxyTo()` (in `lib/search-ai-proxy.ts`) unconditionally:

1. Sets `Content-Type: application/json` (line 53)
2. Calls `JSON.stringify(options.body)` (line 62) — `JSON.stringify(FormData)` → `"{}"`

**This makes file upload impossible through the App Router route.**

Note: paths WITHOUT App Router routes fall through to the middleware proxy (`proxy.ts` line 168)
which uses `NextResponse.rewrite()` — a transparent proxy that preserves the original body.
The upload-hints route works this way. But the upload route HAS an App Router handler that
intercepts it.

**Fix options (pick one):**

**Option A — Delete the App Router route (simplest).** Remove the file at
`apps/studio/src/app/api/search-ai/indexes/[id]/sources/[sourceId]/documents/route.ts`.
Without it, the request falls through to the middleware rewrite at `proxy.ts:168` which
transparently proxies to the search-ai backend. Auth is handled by the search-ai backend's
own auth middleware. This is how `upload-hints`, `crawl`, and `documents` list routes work.

**Option B — Fix the App Router route.** Rewrite it to forward the raw request body:

```typescript
export async function POST(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id, sourceId } = await params;

  const baseUrl = process.env.SEARCH_AI_URL || 'http://localhost:3005';
  const targetUrl = `${baseUrl}/api/indexes/${id}/sources/${sourceId}/documents`;

  // Forward raw body — do NOT parse or re-encode
  const headers: Record<string, string> = {};
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  const contentType = request.headers.get('Content-Type');
  if (contentType) headers['Content-Type'] = contentType;

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: request.body,
    // @ts-expect-error -- duplex required for streaming body in Node.js fetch
    duplex: 'half',
  });

  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
```

**Option C — Fix proxyToSearchEngine.** Add FormData detection:

```typescript
// In proxyTo():
if (options?.body !== undefined) {
  if (options.body instanceof FormData) {
    fetchOptions.body = options.body;
    // Don't set Content-Type — let fetch set multipart boundary
    delete headers['Content-Type'];
  } else {
    fetchOptions.body = JSON.stringify(options.body);
  }
}
```

**Recommendation:** Option A — deleting the App Router route is cleanest. The middleware
proxy handles auth forwarding and is already proven to work for dozens of other search-ai
routes without App Router handlers.

### T-1: Restore API Functions (api/search-ai.ts)

**Add back deleted functions:**

```typescript
// Types
export interface UploadFieldHint {
  storageField: string;
  type: string;
  label: string;
  category: 'core' | 'common';
}

export interface UploadHintsResponse {
  recentFields: string[];
  lastValues: Record<string, string>;
  allFields: UploadFieldHint[];
}

// Functions
export async function uploadDocument(
  indexId: string,
  sourceId: string,
  file: File,
  metadata?: Record<string, unknown>,
): Promise<{
  id: string;
  originalReference: string;
  contentType: string;
  contentSizeBytes: number;
  status: string;
}> {
  const formData = new FormData();
  formData.append('file', file);
  if (metadata) {
    formData.append('metadata', JSON.stringify(metadata));
  }
  // engineUrl → /api/search-ai/indexes/:id/sources/:sourceId/documents
  // Hits Next.js App Router route which proxies to search-ai backend
  // Do NOT set Content-Type — browser auto-sets multipart boundary
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/sources/${sourceId}/documents`), {
    method: 'POST',
    body: formData,
  });
  return handleResponse(response);
}

export async function fetchUploadHints(indexId: string): Promise<UploadHintsResponse> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/upload-hints`));
  return handleResponse(response);
}
```

### T-2: Fix sourceType Mismatch (AddSourceButton.tsx)

When creating a file source, send `sourceType: 'manual'` (not `'file'`) so the
backend auto-creates `ConnectorConfig` with `connectorType: 'file_upload'`.
This enables:

- `connectorId` stamped on uploaded documents
- `uploadFieldHints` persistence (sticky fields)
- Upload hints API returning recent fields

```typescript
// In buildSourceConfig or handleSubmit:
const effectiveSourceType = selectedType === 'file' ? 'manual' : selectedType;
await addSource(indexId, {
  name: form.name.trim(),
  sourceType: effectiveSourceType,
  sourceConfig: buildSourceConfig(),
});
```

### T-3: Build FileUploadDialog Component

**New file:** `apps/studio/src/components/search-ai/data/FileUploadDialog.tsx`

Port from old DocumentsTab with these improvements:

- **Multi-file support** (old was single file)
- **Proper drag-and-drop** (old was click-only despite label saying "drag and drop")
- **Per-file progress** (old had single progress bar)
- **Client-side file size validation** (100MB limit, before sending to backend)
- **Design system components** (Dialog, Button, Input — not raw HTML selects)

**Props:**

```typescript
interface FileUploadDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  sourceId: string;
  sourceName: string;
  onUploadComplete: () => void;
}
```

**Internal flow:**

1. On open: fetch upload hints via SWR (conditional key)
2. Render dropzone (dashed border, click + drag-and-drop)
3. Render metadata fields:
   - If `hintsData.recentFields` non-empty → show as "Previously Used Fields" with
     `lastValues` as placeholders
   - If empty → show defaults: author, category, tags, department
   - "More Fields" expansion → remaining `allFields` minus top fields
   - "Advanced (custom JSON)" → textarea for arbitrary metadata
4. On submit:
   - Build metadata object from structured fields + advanced JSON
   - For each file: call `uploadDocument(indexId, sourceId, file, metadata)`
   - Show per-file progress
   - On all complete: toast success, call `onUploadComplete()`

### T-4: Wire Upload Into AddSourceButton Flow

**Modified flow for file type:**

```
Step 1: Type selection → user picks "File Upload"
Step 2: Source name input (simplified — just name field)
Step 3: On submit → create source with sourceType: 'manual'
        → capture returned source._id
        → close AddSource dialog
        → open FileUploadDialog with new sourceId
```

Change `AddSourceButton` to emit the new source info:

```typescript
interface AddSourceButtonProps {
  indexId: string;
  onSourceAdded: (source?: { _id: string; name: string; sourceType: string }) => void;
}
```

`DataSection` receives the source info and opens `FileUploadDialog`:

```typescript
const [uploadTarget, setUploadTarget] = useState<{ sourceId: string; sourceName: string } | null>(
  null,
);

const handleSourceAdded = (source?: { _id: string; name: string }) => {
  onRefreshSources();
  if (source?.sourceType === 'manual' || source?.sourceType === 'file') {
    setUploadTarget({ sourceId: source._id, sourceName: source.name });
  }
};
```

### T-5: Add Upload Action for Existing File Sources

In `SourceFilterBar` or `DocumentTable`, add an upload button for existing file/manual sources.

**Option A — SourceFilterBar:** Add an Upload icon button next to AddSourceButton when
a file source filter is active.

**Option B — DocumentTable:** Add an "Upload Files" button in the header area when
`sourceFilter` points to a file/manual source.

**Option C — Both:** Upload shortcut in filter bar + prominent button in table header.

### T-6: i18n Strings

Add to `packages/i18n/locales/en/studio.json` under `search_ai.upload`:

- `dialog_title`, `dialog_title_existing`
- `dropzone_label`, `dropzone_hint`, `dropzone_formats`
- `label_source_name`, `placeholder_source_name`
- `section_recently_used`, `section_common_fields`, `section_more_fields`, `section_advanced`
- `button_upload`, `button_upload_count` (with count interpolation)
- `progress_uploading`, `progress_complete`
- `error_file_too_large`, `error_upload_failed`, `error_invalid_json`
- `toast_upload_success`, `toast_upload_success_count`

### ~~T-7: Canonical Mapping~~ — NOT NEEDED for File Uploads

The `file_upload` connector template and FieldMapping system is designed for **connectors
with dynamic incoming data** (SharePoint, APIs, databases) where source field names need
to be automatically discovered and mapped to canonical slots.

For file uploads, the user **explicitly selects canonical field names** (author, category,
tags, etc.) from `AVAILABLE_CANONICAL_FIELDS` and provides values directly. The metadata
IS canonical data — there's no schema discovery or automatic mapping needed.

The values are stored under `sourceMetadata.file_upload.*` namespace (line 485-492 of
`document-upload.ts`), which is the correct storage format. Search and filtering work
against `sourceMetadata` directly via the document's stored fields.

**No action needed.**

## Critical Design Decisions

### D-1: sourceType: 'manual' vs 'file'

**Decision:** Send `sourceType: 'manual'` to the backend.

**Why:** The backend's `ConnectorConfig` auto-creation (sources.ts:157) only triggers
for `'manual'`. Without it, no `connectorId` is assigned, breaking:

- Upload hints persistence
- Document `connectorId` field (used for filtering/grouping)
- Future connector-level operations

The UI can still display "File Upload" as the label — the backend sourceType is an
implementation detail. The old working code also used `'manual'`.

### D-2: Multi-file vs Single-file

**Decision:** Support multi-file upload.

**Why:** The backend already handles one file per request. The frontend queues
multiple uploads sequentially. This is a UX improvement over the old single-file
dialog where users had to reopen the dialog for each file.

### D-3: Metadata applies to all files in batch

**Decision:** Single set of metadata fields applies to all files in a batch upload.

**Why:** Simplifies UX. Users uploading related files typically want the same
metadata (category, department, tags). Per-file metadata can be done via separate
uploads or the advanced JSON field.

### D-4: Drag-and-drop implementation

**Decision:** Real drag-and-drop with `onDragOver`/`onDrop` handlers.

**Why:** The old code had a clickable div that said "drag and drop" but only
supported click. Proper DnD is expected for enterprise file upload.

## File Manifest

| File                                                                                   | Action     | Description                                                                          |
| -------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `apps/studio/src/app/api/search-ai/indexes/[id]/sources/[sourceId]/documents/route.ts` | **Delete** | Remove broken App Router route — let middleware proxy handle multipart transparently |
| `apps/studio/src/api/search-ai.ts`                                                     | Modify     | Add `uploadDocument`, `fetchUploadHints`, types                                      |
| `apps/studio/src/components/search-ai/data/FileUploadDialog.tsx`                       | **Create** | New upload dialog with dropzone, metadata, progress                                  |
| `apps/studio/src/components/search-ai/data/AddSourceButton.tsx`                        | Modify     | Send `sourceType: 'manual'` for file, emit source info, remove old file config form  |
| `apps/studio/src/components/search-ai/data/DataSection.tsx`                            | Modify     | Add upload dialog state, wire `handleSourceAdded` with source info                   |
| `apps/studio/src/components/search-ai/data/SourceFilterBar.tsx`                        | Modify     | Update `onAddSource` type to accept optional source parameter                        |
| `apps/studio/src/components/search-ai/data/DocumentTable.tsx`                          | Modify     | Add "Upload Files" button, add sourceId/sourceName/sourceType props                  |
| `apps/studio/src/components/search-ai/data/index.ts`                                   | Modify     | Export `FileUploadDialog` if needed                                                  |
| `packages/i18n/locales/en/studio.json`                                                 | Modify     | Add upload-related i18n strings                                                      |

## Review Findings (3 Iterations Completed)

### Iteration 1 — API Correctness

| #   | Severity     | Finding                                                                                                                               | Resolution                                                                                                                                                          |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | **CRITICAL** | `proxyToSearchEngine` forces `JSON.stringify(body)` + `Content-Type: application/json` — destroys FormData in App Router upload route | Added T-0: delete App Router route, let middleware proxy handle                                                                                                     |
| R-2 | ~~CRITICAL~~ | ~~No App Router route for upload-hints~~                                                                                              | False alarm — no route needed. Falls through to middleware `NextResponse.rewrite()` which transparently proxies. This is how dozens of other search-ai routes work. |
| R-3 | LOW          | `uploadDocument` return type missing `metadata`, `createdAt` fields from actual response                                              | Accept — client doesn't need them                                                                                                                                   |

### Iteration 2 — Component Integration

| #   | Severity | Finding                                                                                                                                        | Resolution                              |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| R-4 | HIGH     | `SourceFilterBar.tsx` not in file manifest — `onAddSource` type needs updating across chain: `DataSection → SourceFilterBar → AddSourceButton` | Added to file manifest                  |
| R-5 | MEDIUM   | `DocumentTable` needs `sourceId`/`sourceName`/`sourceType` props to show upload button                                                         | Noted in T-5 prop requirements          |
| R-6 | OK       | `EmptyState` supports `action` prop for upload shortcut                                                                                        | Confirmed at EmptyState.tsx line 13     |
| R-7 | OK       | `addSource()` returns `{ source: SearchAISource }` with `_id` — T-4 source capture is feasible                                                 | Confirmed at search-ai.ts lines 706-716 |

### Iteration 3 — Backend Compatibility

| #    | Severity | Finding                                                                                                 | Resolution                                   |
| ---- | -------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| R-8  | OK       | Upload hints route imports `AVAILABLE_CANONICAL_FIELDS`, filters to core+common, returns correct shape  | Confirmed — design matches                   |
| R-9  | OK       | `connectorConfig = null` when no ConnectorConfig → upload still works, just no sticky hints             | Confirmed — design's D-1 decision is correct |
| R-10 | OK       | `POST /sources` returns source with `_id`                                                               | Confirmed at sources.ts line 177             |
| R-11 | INFO     | Backend `document-upload.ts` header comment says "Removed: CSV, JSON, XML" but code still supports them | Pre-existing stale docs, not our issue       |

## Review Checklist

- [ ] T-0: Delete broken App Router upload route (multipart proxy fix)
- [ ] `uploadDocument` uses FormData without Content-Type header (browser sets boundary)
- [ ] `sourceType: 'manual'` sent for file sources (triggers ConnectorConfig creation)
- [ ] Upload hints fetched conditionally (only when dialog open)
- [ ] Metadata fields render dynamically from canonical schema (type-aware inputs)
- [ ] Recently used fields shown first with last values as placeholders
- [ ] "More Fields" expands remaining core+common canonical fields
- [ ] Advanced JSON merges into structured fields (JSON overwrites on collision)
- [ ] Client-side 100MB file size validation before upload
- [ ] Per-file progress tracking for multi-file uploads
- [ ] Error handling: file too large, upload failed, invalid JSON, source creation failed
- [ ] Design system components used (Dialog, Button, Input — no raw HTML)
- [ ] i18n for all user-facing strings
- [ ] onUploadComplete triggers source refresh + document table refresh
- [ ] SourceFilterBar.onAddSource type updated in full callback chain
- [ ] Drag-and-drop with onDragOver/onDrop (not just click)
- [ ] File type filter: `.pdf,.docx,.doc,.pptx,.ppt,.html,.htm,.txt,.md,.json,.csv,.xlsx,.xls`

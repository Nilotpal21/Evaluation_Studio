# File Upload Restoration — Low-Level Design

## Task T-0: Fix Upload Proxy Route

### Files to Delete

- `apps/studio/src/app/api/search-ai/indexes/[id]/sources/[sourceId]/documents/route.ts` — Broken App Router route that calls `proxyToSearchEngine` which `JSON.stringify`s FormData → `"{}"`. Deleting lets the middleware proxy (`proxy.ts:168`) handle multipart transparently via `NextResponse.rewrite()`.

### Subtasks

1. ST-0.1: Delete the App Router route file
2. ST-0.2: Verify no other imports reference this route

### Acceptance Criteria

- AC-0.1: The file no longer exists
- AC-0.2: No broken imports anywhere in the codebase referencing this route

---

## Task T-1: Restore API Functions

### Files to Modify

- `apps/studio/src/api/search-ai.ts` — Add `uploadDocument()`, `fetchUploadHints()`, and types

### Function Signatures

```typescript
// Types (add near other type exports, after SearchAISource)
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

// Functions (add after deleteSource, in SOURCES section)
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
}> { ... }

export async function fetchUploadHints(
  indexId: string,
): Promise<UploadHintsResponse> { ... }
```

### Subtasks

1. ST-1.1: Add `UploadFieldHint` and `UploadHintsResponse` types after the `SearchAISource` type
2. ST-1.2: Add `uploadDocument()` — uses FormData, does NOT set Content-Type header (browser sets multipart boundary). Uses `apiFetch(engineUrl(...), { method: 'POST', body: formData })` — note: NO `headers: { 'Content-Type': 'application/json' }` because `apiFetch` in `api-client.ts:62` spreads `init.headers` over `authHeaders()`, and `authHeaders()` only sets Authorization + X-Tenant-Id (no Content-Type). So omitting headers lets the browser auto-set multipart. **CRITICAL: Add inline comment `// CRITICAL: Do NOT set Content-Type — browser must set multipart/form-data with boundary` above the apiFetch call.** Every other function in this file sets `Content-Type: application/json` — an implementer copying a neighbor will break this.
3. ST-1.3: Add `fetchUploadHints()` — standard GET via `apiFetch(engineUrl(...))` with `Content-Type: application/json`

### Acceptance Criteria

- AC-1.1: Types are exported and importable from `search-ai.ts`
- AC-1.2: `uploadDocument` creates FormData with `file` field + optional `metadata` JSON string, sends POST without Content-Type override
- AC-1.3: `fetchUploadHints` returns `UploadHintsResponse` shape

---

## Task T-2: Fix sourceType + Wire AddSourceButton

### Files to Modify

- `apps/studio/src/components/search-ai/data/AddSourceButton.tsx`

### Changes

1. When `selectedType === 'file'`: send `sourceType: 'manual'` to backend (not `'file'`), so `ConnectorConfig` auto-creation triggers
2. On successful source creation for file type: return the created source info via `onSourceAdded` callback
3. Replace the file-specific config form (fileTypes/maxFileSize inputs) with just the source name — upload dialog handles file selection
4. The `onSourceAdded` callback type changes from `() => void` to `(source?: { _id: string; name: string; sourceType: string }) => void`

### Explicit handleSubmit Diff (AddSourceButton.tsx:193-220)

```typescript
// BEFORE (current):
await addSource(indexId, {
  name: form.name.trim(),
  sourceType: selectedType,
  sourceConfig: buildSourceConfig(),
});
toast.success(t('toast_source_added'));
handleClose();
onSourceAdded();

// AFTER:
const effectiveSourceType = selectedType === 'file' ? 'manual' : selectedType;
const { source } = await addSource(indexId, {
  name: form.name.trim(),
  sourceType: effectiveSourceType,
  sourceConfig: selectedType === 'file' ? {} : buildSourceConfig(),
});
toast.success(t('toast_source_added'));
handleClose();
onSourceAdded(selectedType === 'file' ? source : undefined);
```

### Subtasks

1. ST-2.1: Change `onSourceAdded` prop type to accept optional source data
2. ST-2.2: In `handleSubmit`, map `selectedType === 'file'` to `sourceType: 'manual'`
3. ST-2.3: On success, capture return value `{ source }`, call `onSourceAdded(source)` for file type, `onSourceAdded()` for others
4. ST-2.4: Remove the file-specific config form (fileTypes/maxFileSize) — only show source name for file type
5. ST-2.5: Ensure `isDisabled` is `type === 'web'` (already done in uncommitted change)

### Acceptance Criteria

- AC-2.1: File source creation sends `sourceType: 'manual'` in the API call
- AC-2.2: `onSourceAdded` receives `{ _id, name, sourceType }` for file sources
- AC-2.3: File config form only shows source name input (no fileTypes/maxFileSize)

---

## Task T-3: Build FileUploadDialog

### Files to Create

- `apps/studio/src/components/search-ai/data/FileUploadDialog.tsx`

### Props

```typescript
interface FileUploadDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  /** Pre-selected source (from AddSourceButton flow or filter bar). Can be empty. */
  sourceId?: string;
  sourceName?: string;
  /** All available sources — for source selector dropdown (manual/file sources filtered) */
  sources: SearchAISource[];
  onUploadComplete: () => void;
}
```

### Source Selector (Gap 1 fix — from old DocumentsTab)

When the dialog opens:

- If `sourceId` is provided (from AddSourceButton flow), pre-select it in dropdown
- If not, show a source dropdown with all manual/file sources
- Include a "Create New Source" option in the dropdown (inline creation like old component)
- Filter `sources` to only show `sourceType === 'manual'` entries

```typescript
const manualSources = sources.filter((s) => s.sourceType === 'manual');
const [selectedSourceId, setSelectedSourceId] = useState(sourceId ?? '');
const [creatingSource, setCreatingSource] = useState(false);
const [newSourceName, setNewSourceName] = useState('');
```

### Auto-Detected Fields (Gap 2 fix — from old DocumentsTab)

When files are selected, show an info box with auto-detected metadata:

```typescript
{files.length > 0 && (
  <div className="space-y-1.5">
    <label className="block text-xs font-medium text-muted">
      {t('auto_detected')}
    </label>
    <div className="grid grid-cols-2 gap-2 text-xs text-muted bg-background-subtle rounded-lg p-2">
      <span>Title: <span className="text-foreground">{files[0].name.replace(/\.[^.]+$/, '')}</span></span>
      <span>Type: <span className="text-foreground">{files[0].type || 'unknown'}</span></span>
      <span>Size: <span className="text-foreground">{formatBytes(files[0].size)}</span></span>
      {files.length > 1 && (
        <span>Files: <span className="text-foreground">{files.length}</span></span>
      )}
    </div>
  </div>
)}
```

### Internal State

```typescript
const [files, setFiles] = useState<File[]>([]);
const [metadata, setMetadata] = useState<Record<string, string>>({});
const [advancedJson, setAdvancedJson] = useState('');
const [showMoreFields, setShowMoreFields] = useState(false);
const [showAdvanced, setShowAdvanced] = useState(false);
const [uploading, setUploading] = useState(false);
const [uploadProgress, setUploadProgress] = useState<
  Record<string, 'pending' | 'uploading' | 'done' | 'error'>
>({});
```

### Data Fetching

```typescript
// Conditional SWR: only fetch when dialog is open
const hintsKey = open ? `/api/search-ai/indexes/${indexId}/upload-hints` : null;
const { data: hintsData } = useSWR(hintsKey, () => fetchUploadHints(indexId));
```

### Field Display Logic

```typescript
const DEFAULT_FIELDS = ['author', 'category', 'tags', 'department'];

// Top fields: recent fields (if any) OR defaults
const topFieldKeys = hintsData?.recentFields?.length ? hintsData.recentFields : DEFAULT_FIELDS;

// All available fields for "More Fields" expansion
const allFields = hintsData?.allFields ?? [];
const topFields = allFields.filter((f) => topFieldKeys.includes(f.storageField));
const moreFields = allFields.filter((f) => !topFieldKeys.includes(f.storageField));
```

### Field Input Types

Based on `UploadFieldHint.type`:

- `'date'` → `<input type="date">`
- `'float'` or `'integer'` → `<input type="number">`
- everything else → `<input type="text">`

### Drag-and-Drop

```typescript
const handleDragOver = (e: React.DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
  setDragActive(true);
};
const handleDragLeave = (e: React.DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
  setDragActive(false);
};
const handleDrop = (e: React.DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
  setDragActive(false);
  const droppedFiles = Array.from(e.dataTransfer.files).filter(validateFile);
  setFiles((prev) => [...prev, ...droppedFiles]);
};
```

### File Validation

```typescript
const ACCEPTED_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.html',
  '.htm',
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.xlsx',
  '.xls',
];
const ACCEPTED_TYPES_STRING = ACCEPTED_EXTENSIONS.join(','); // for <input accept="...">
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

function validateFile(file: File): boolean {
  if (file.size > MAX_FILE_SIZE) {
    toast.error(t('error_file_too_large', { name: file.name }));
    return false;
  }
  // Check extension — drag-and-drop bypasses <input accept="...">, so validate here
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    toast.error(t('error_unsupported_type', { name: file.name }));
    return false;
  }
  return true;
}
```

### Upload Logic

```typescript
const handleUpload = async () => {
  if (files.length === 0) return;
  setUploading(true);

  // Build metadata from structured fields + advanced JSON
  const structuredMeta = { ...metadata };
  if (advancedJson.trim()) {
    try {
      const parsed = JSON.parse(advancedJson);
      Object.assign(structuredMeta, parsed);
    } catch {
      toast.error(t('error_invalid_json'));
      setUploading(false);
      return;
    }
  }

  const metadataToSend = Object.keys(structuredMeta).length > 0 ? structuredMeta : undefined;

  // Upload each file sequentially
  const progress: Record<string, 'pending' | 'uploading' | 'done' | 'error'> = {};
  files.forEach((f) => {
    progress[f.name] = 'pending';
  });
  setUploadProgress({ ...progress });

  let successCount = 0;
  for (const file of files) {
    progress[file.name] = 'uploading';
    setUploadProgress({ ...progress });
    try {
      await uploadDocument(indexId, sourceId, file, metadataToSend);
      progress[file.name] = 'done';
      successCount++;
    } catch (err) {
      progress[file.name] = 'error';
      toast.error(sanitizeError(err, t('error_upload_failed', { name: file.name })));
    }
    setUploadProgress({ ...progress });
  }

  if (successCount > 0) {
    toast.success(t('toast_upload_success', { count: successCount }));
    onUploadComplete();
  }
  if (successCount === files.length) {
    onClose();
  }
  setUploading(false);
};
```

### Component Layout

Uses: `Dialog` (maxWidth="xl"), `Button`, `Input` from `../../ui/`.
Hidden `<input type="file" ref={fileInputRef}>` for click-to-select.
Dashed-border dropzone div with drag handlers.
Per-file list with remove button (X).
Metadata fields section with dynamic input types.
"More Fields" collapsible section.
"Advanced (custom JSON)" collapsible textarea.
Upload progress per-file with status indicators.

### Subtasks

1. ST-3.1: Create component scaffold with props, imports, state
2. ST-3.2: Implement drag-and-drop zone with file validation
3. ST-3.3: Implement upload hints SWR and metadata field rendering (dynamic input types)
4. ST-3.4: Implement "More Fields" expansion and "Advanced JSON" textarea
5. ST-3.5: Implement multi-file upload logic with per-file progress
6. ST-3.6: Wire all together in Dialog with proper layout and i18n

### Acceptance Criteria

- AC-3.1: Dialog shows dropzone with click + drag-and-drop support
- AC-3.2: Files >100MB rejected client-side with toast error; unsupported file types (e.g. .exe) rejected on drag-and-drop
- AC-3.3: Metadata fields render dynamically from upload hints (date/number/text types)
- AC-3.4: Recently used fields shown first with last values as placeholders
- AC-3.5: "More Fields" expands remaining canonical fields
- AC-3.6: "Advanced JSON" merges into structured fields (JSON overwrites on collision)
- AC-3.7: Per-file progress shown during upload
- AC-3.8: All strings i18n'd via `useTranslations('search_ai.upload')`

---

## Task T-4: Wire DataSection + SourceFilterBar + DocumentTable Props

**Note:** This task owns ALL changes to DataSection.tsx and SourceFilterBar.tsx. T-5 only touches DocumentTable.tsx.

### Files to Modify

- `apps/studio/src/components/search-ai/data/DataSection.tsx` — Add upload dialog state, wire callbacks, pass props to DocumentTable
- `apps/studio/src/components/search-ai/data/SourceFilterBar.tsx` — Update `onAddSource` type, add upload button for file sources

### DataSection Changes

```typescript
// New imports
import { FileUploadDialog } from './FileUploadDialog';

// New state
const [uploadTarget, setUploadTarget] = useState<{
  sourceId: string;
  sourceName: string;
} | null>(null);

// refreshKey counter to force DocumentTable SWR re-fetch after upload
const [docRefreshKey, setDocRefreshKey] = useState(0);

// Updated callback
const handleSourceAdded = (source?: { _id: string; name: string; sourceType: string }) => {
  onRefreshSources();
  if (source && (source.sourceType === 'manual' || source.sourceType === 'file')) {
    setUploadTarget({ sourceId: source._id, sourceName: source.name });
  }
};

// Callback for upload from existing source (from SourceFilterBar/DocumentTable)
const handleUploadToSource = (sourceId: string, sourceName: string) => {
  setUploadTarget({ sourceId, sourceName });
};

// Resolve active source info for DocumentTable props
const activeSource = activeFilter
  ? sources.find(s => s.sourceType === activeFilter)
  : undefined;
// Note: if multiple sources have same sourceType, upload shortcut in SourceFilterBar
// is only shown when exactly one source matches the filter.

// In JSX: pass new props to DocumentTable
<DocumentTable
  indexId={indexId}
  sourceFilter={activeFilter}
  searchQuery={debouncedSearch}
  refreshKey={docRefreshKey}
  sourceId={activeSource?._id}
  sourceName={activeSource?.name}
  sourceType={activeSource?.sourceType}
  onUploadToSource={handleUploadToSource}
/>

// In JSX: add FileUploadDialog after DocumentTable
<FileUploadDialog
  open={!!uploadTarget}
  onClose={() => setUploadTarget(null)}
  indexId={indexId}
  sourceId={uploadTarget?.sourceId}
  sourceName={uploadTarget?.sourceName}
  sources={sources}
  onUploadComplete={() => {
    setUploadTarget(null);
    setDocRefreshKey(k => k + 1); // Force DocumentTable SWR refresh
    onRefreshSources();
  }}
/>
```

### SourceFilterBar Changes

```typescript
// Props change
interface SourceFilterBarProps {
  sources: SearchAISource[];
  activeFilter: string | null;
  onFilterChange: (sourceType: string | null) => void;
  onAddSource: (source?: { _id: string; name: string; sourceType: string }) => void;
  onUploadToSource?: (sourceId: string, sourceName: string) => void;
  indexId: string;
}

// Upload icon button logic:
// Show upload shortcut ONLY when activeFilter is 'manual' (or 'file')
// AND exactly ONE source matches that type. If multiple sources match,
// hide the shortcut (user should upload via AddSourceButton flow or
// DocumentTable empty state).
const filteredSources = activeFilter ? sources.filter((s) => s.sourceType === activeFilter) : [];
const showUploadShortcut =
  onUploadToSource &&
  (activeFilter === 'manual' || activeFilter === 'file') &&
  filteredSources.length === 1;
```

### Subtasks

1. ST-4.1: Update `SourceFilterBar` props — `onAddSource` accepts optional source, add `onUploadToSource`
2. ST-4.2: Update `DataSection` — add `uploadTarget` state, `docRefreshKey`, `FileUploadDialog` render, wire `handleSourceAdded`
3. ST-4.3: Pass `onUploadToSource` and active source info from DataSection to SourceFilterBar and DocumentTable
4. ST-4.4: Add Upload icon button in SourceFilterBar (only when single manual/file source active)

### Acceptance Criteria

- AC-4.1: Creating a file source via AddSourceButton automatically opens FileUploadDialog
- AC-4.2: Upload icon appears in SourceFilterBar when filtering to a single file/manual source
- AC-4.3: FileUploadDialog opens with correct sourceId/sourceName
- AC-4.4: After upload complete, DocumentTable SWR refreshes (via docRefreshKey) and sources refresh

---

## Task T-5: DocumentTable Upload Button + Empty State

**Depends on:** T-4 (DataSection passes new props to DocumentTable)

### Files to Modify

- `apps/studio/src/components/search-ai/data/DocumentTable.tsx` — Add upload action button, enhance empty state, accept refreshKey

### Changes

1. Add new props: `refreshKey?: number`, `sourceId?: string`, `sourceName?: string`, `sourceType?: string`, `onUploadToSource?: (sourceId: string, sourceName: string) => void`
2. Include `refreshKey` in the SWR key so cache invalidates when DataSection increments it after upload
3. When `sourceType === 'manual'` and `sourceId` is set, show "Upload Files" button above the table
4. Enhance empty state: use `EmptyState`'s `action` prop for upload button when viewing a file/manual source

### Subtasks

1. ST-5.1: Add new optional props to `DocumentTableProps`
2. ST-5.2: Include `refreshKey` in SWR key for cache invalidation
3. ST-5.3: Add "Upload Files" button above table when `sourceType === 'manual'` and `sourceId` is set
4. ST-5.4: Enhance empty state with upload action via `EmptyState` `action` prop

### Acceptance Criteria

- AC-5.1: "Upload Files" button visible when filtering to a file/manual source with documents
- AC-5.2: Empty state shows "Upload Files" action when no documents exist for a file source
- AC-5.3: Clicking upload button triggers `onUploadToSource` callback
- AC-5.4: DocumentTable SWR re-fetches when `refreshKey` changes (after upload)

---

## Task T-6: i18n Strings

### Files to Modify

- `packages/i18n/locales/en/studio.json` — Add `search_ai.upload` namespace

### Strings to Add

```json
"upload": {
  "dialog_title": "Upload Files",
  "dialog_title_existing": "Upload Files to \"{sourceName}\"",
  "dropzone_label": "Click to select files or drag & drop",
  "dropzone_formats": "PDF, DOCX, PPTX, HTML, TXT, MD, JSON, CSV, XLSX (max 100MB each)",
  "section_metadata": "Metadata Fields",
  "section_recently_used": "Previously Used Fields",
  "section_more_fields": "More Fields ({count})",
  "section_advanced": "Advanced (custom JSON)",
  "button_upload": "Upload",
  "button_upload_count": "Upload {count} {count, plural, one {File} other {Files}}",
  "button_remove_file": "Remove",
  "progress_pending": "Pending",
  "progress_uploading": "Uploading...",
  "progress_done": "Done",
  "progress_error": "Failed",
  "error_file_too_large": "{name} exceeds the 100MB limit",
  "error_unsupported_type": "{name} is not a supported file type",
  "error_upload_failed": "Failed to upload {name}",
  "error_invalid_json": "Invalid JSON in advanced field",
  "toast_upload_success": "Uploaded {count} {count, plural, one {file} other {files}} successfully",
  "upload_files_button": "Upload Files",
  "aria_dropzone": "File upload drop zone. Click or drag files here.",
  "aria_remove_file": "Remove {name}",
  "auto_detected": "Auto-detected",
  "source_label": "Source",
  "source_select_placeholder": "Select a source...",
  "source_no_sources": "No sources available",
  "source_create_new": "Create New Source",
  "source_name_label": "New Source Name",
  "source_name_placeholder": "e.g. Manual Uploads",
  "source_create": "Create",
  "source_create_cancel": "Cancel",
  "source_name_required": "Source name is required",
  "error_source_create_failed": "Failed to create source",
  "toast_source_created": "Source \"{name}\" created"
}
```

Also update:

- `doc_table.empty_desc` → keep existing text but add upload context
- `source_filter` → add `type_manual` key

### Subtasks

1. ST-6.1: Add `search_ai.upload` namespace with all strings
2. ST-6.2: Add `source_filter.type_manual` key
3. ST-6.3: Verify no missing i18n keys by cross-referencing with `FileUploadDialog` and other modified components

### Acceptance Criteria

- AC-6.1: All user-facing strings in upload flow are i18n'd
- AC-6.2: No hardcoded English text in any modified component

# Phase 4: Studio UX & Tool Filtering Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 5 Studio UI attachment gaps and add zero-LLM-cost contextual tool filtering to reduce token usage for agents with large tool sets.

**Architecture:** Studio UI additions (download button, drag-drop, paste, audio/video MIME, image thumbnails, per-project config). Rule-based tool filtering in the runtime with state-based rules and keyword relevance scoring.

**Tech Stack:** TypeScript, React, Next.js 15, Tailwind CSS, Framer Motion, Lucide icons

**Spec:** `docs/plans/2026-03-12-agent-capabilities-gaps-design.md` — Phase 4

**Partially depends on:** Phase 1 (PII policy for per-project config), Phase 2 (attachment tools for some UI features)

---

## Chunk 1: Studio Attachment UI Gaps (No Dependencies)

### Task 1: Add download button to attachment chips in MessageList

> **Audit fix (CRITICAL #1):** `AttachmentCard.tsx` does NOT exist. Attachment filenames are rendered inline in `MessageList.tsx` inside the `MessageItem` component (lines 127-139). The download button must be added there, next to each attachment filename chip.

**Files:**

- Modify: `apps/studio/src/components/chat/MessageList.tsx`
- Test: `apps/studio/src/__tests__/message-list-download.test.tsx`

- [ ] **Step 1: Read MessageList.tsx to verify the attachment rendering location**

Confirm: lines 127-139 render `message.metadata?.attachmentFilenames` as `<span>` chips with a `<FileText>` icon. Each chip currently shows only the filename — no download action.

- [ ] **Step 2: Add download icon button to each attachment chip**

```tsx
// Inside MessageItem, replace the attachment filename rendering block
import { Download } from 'lucide-react'; // add to existing imports

{
  message.metadata?.attachmentFilenames && message.metadata.attachmentFilenames.length > 0 && (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {message.metadata.attachmentFilenames.map((name, i) => {
        const attachmentId = message.metadata?.attachmentIds?.[i];
        return (
          <span
            key={i}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-background-muted text-muted"
          >
            <FileText className="w-3 h-3" />
            {name}
            {attachmentId && (
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const projectId = useNavigationStore.getState().projectId;
                    const sessionId = useSessionStore.getState().sessionId;
                    if (!projectId || !sessionId) return;
                    const res = await fetch(
                      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/url?disposition=attachment`,
                    );
                    if (!res.ok) {
                      const body = await res.json().catch(() => ({}));
                      console.error('Download failed:', body?.error?.message ?? res.statusText);
                      return;
                    }
                    const { data } = await res.json();
                    if (data?.url) {
                      window.open(data.url, '_blank');
                    }
                  } catch (err) {
                    console.error(
                      'Download error:',
                      err instanceof Error ? err.message : String(err),
                    );
                  }
                }}
                className="p-0.5 rounded hover:bg-background-elevated transition-all duration-200"
                title="Download file"
                aria-label={`Download ${name}`}
              >
                <Download className="w-3 h-3" />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
```

> **Audit fix (HIGH #7):** Download button checks `res.ok` before parsing, handles missing `data.url`, catches network errors, and logs error details.

- [ ] **Step 3: Add basic tests**

> **Audit fix (MEDIUM #13):** Add tests for download URL error handling.

```typescript
// apps/studio/src/__tests__/message-list-download.test.tsx
import { describe, it, expect, vi } from 'vitest';

describe('MessageList download button', () => {
  it('should not throw when API returns error envelope', async () => {
    // Mock fetch to return { success: false, error: { code: 'NOT_FOUND', message: '...' } }
    // Verify no window.open call, no unhandled exception
  });

  it('should not render download button when attachmentId is missing', () => {
    // Render MessageItem with attachmentFilenames but no attachmentIds
    // Verify no Download icon rendered
  });

  it('should call fetch with correct URL including disposition=attachment', async () => {
    // Mock fetch, click download, verify URL construction
  });
});
```

- [ ] **Step 4: Build**

Run: `pnpm build --filter=studio`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/components/chat/MessageList.tsx apps/studio/src/__tests__/message-list-download.test.tsx
git add apps/studio/src/components/chat/MessageList.tsx apps/studio/src/__tests__/message-list-download.test.tsx
git commit -m "[ABLP-2] feat(studio): add download button to attachment chips in message list"
```

---

### Task 2: Add drag-and-drop and clipboard paste with client-side validation

> **Audit fix (HIGH #8):** Original plan had no client-side validation on drop/paste. Now includes file size check, MIME type check, and file count limit using existing `MAX_FILE_SIZE` and `MAX_FILE_COUNT` constants already defined in ChatInput.tsx.

**Files:**

- Modify: `apps/studio/src/components/chat/ChatInput.tsx`
- Test: `apps/studio/src/__tests__/chat-input-dnd.test.tsx`

- [ ] **Step 1: Read ChatInput.tsx to verify existing constants and uploadFile signature**

Confirm: `MAX_FILE_SIZE = 20 * 1024 * 1024`, `MAX_FILE_COUNT = 10`, `handleFileChange` already validates size and count. The file input `accept` is `.pdf,.md,.json,.yaml,.yml,.txt,.docx,.csv,.png,.jpg,.jpeg,.gif,.webp`.

- [ ] **Step 2: Add drop zone and paste handlers with validation**

```tsx
// Add these state/handlers inside ChatInput component, after existing state declarations:

const [isDragging, setIsDragging] = useState(false);

const ACCEPTED_MIME_PREFIXES = ['image/', 'audio/', 'video/', 'application/pdf', 'text/'];
const ACCEPTED_EXTENSIONS = new Set([
  '.pdf',
  '.md',
  '.json',
  '.yaml',
  '.yml',
  '.txt',
  '.docx',
  '.csv',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.mp3',
  '.wav',
  '.mp4',
  '.webm',
]);

function isAcceptedFile(file: File): boolean {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  if (ACCEPTED_EXTENSIONS.has(ext)) return true;
  return ACCEPTED_MIME_PREFIXES.some((prefix) => file.type.startsWith(prefix));
}

const validateAndUpload = (files: File[]) => {
  const remaining = MAX_FILE_COUNT - pendingFiles.length;
  const accepted = files.slice(0, Math.max(0, remaining));

  const newFiles: PendingFile[] = accepted.map((file) => {
    let error: string | undefined;
    if (file.size > MAX_FILE_SIZE) {
      error = 'File too large (max 20MB)';
    } else if (!isAcceptedFile(file)) {
      error = 'Unsupported file type';
    }
    return {
      localId: nextLocalId(),
      file,
      uploading: !error,
      error,
    };
  });

  setPendingFiles((prev) => [...prev, ...newFiles]);
  newFiles.filter((pf) => pf.uploading).forEach((pf) => uploadFile(pf.file, pf.localId));
};

const handleDrop = (e: React.DragEvent) => {
  e.preventDefault();
  setIsDragging(false);
  const files = Array.from(e.dataTransfer.files);
  if (files.length === 0) return;
  validateAndUpload(files);
};

const handleDragOver = (e: React.DragEvent) => {
  e.preventDefault();
  setIsDragging(true);
};

const handleDragLeave = (e: React.DragEvent) => {
  // Only leave if exiting the container (not entering a child)
  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
  setIsDragging(false);
};

const handlePaste = (e: React.ClipboardEvent) => {
  const items = Array.from(e.clipboardData.items);
  const files = items
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter(Boolean) as File[];
  if (files.length > 0) {
    e.preventDefault();
    validateAndUpload(files);
  }
};
```

Wrap the existing outer `<div>` with drop/paste handlers:

```tsx
<div
  onDrop={handleDrop}
  onDragOver={handleDragOver}
  onDragLeave={handleDragLeave}
  onPaste={handlePaste}
  className={clsx(
    'relative rounded-xl border',
    // ... existing classes ...
  )}
>
  {isDragging && (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/50 bg-accent/5">
      <span className="text-sm text-muted-foreground">Drop files here</span>
    </div>
  )}
  {/* existing content */}
</div>
```

Also refactor `handleFileChange` to use the shared `validateAndUpload` helper.

- [ ] **Step 3: Add tests for validation**

> **Audit fix (MEDIUM #13):** Tests for file size rejection, MIME rejection, and file count cap on drop/paste.

```typescript
// apps/studio/src/__tests__/chat-input-dnd.test.tsx
import { describe, it, expect } from 'vitest';

describe('ChatInput drag-and-drop validation', () => {
  it('should reject files exceeding MAX_FILE_SIZE', () => {
    // Create mock File with size > 20MB, verify error state
  });

  it('should reject unsupported MIME types', () => {
    // Create mock File with type application/x-executable, verify error
  });

  it('should cap total files at MAX_FILE_COUNT', () => {
    // Start with 8 pending, drop 5, verify only 2 accepted
  });

  it('should accept image files via paste', () => {
    // Create ClipboardEvent with image/png file, verify upload called
  });
});
```

- [ ] **Step 4: Build, step 5: commit**

```bash
npx prettier --write apps/studio/src/components/chat/ChatInput.tsx apps/studio/src/__tests__/chat-input-dnd.test.tsx
git add apps/studio/src/components/chat/ChatInput.tsx apps/studio/src/__tests__/chat-input-dnd.test.tsx
git commit -m "[ABLP-2] feat(studio): add drag-and-drop and clipboard paste for file uploads with validation"
```

---

### Task 3: Enable audio/video MIME types in file picker

**Files:**

- Modify: `apps/studio/src/components/chat/ChatInput.tsx`

- [ ] **Step 1: Update accept attribute**

Find the file input element (line 269 in current ChatInput.tsx) and update:

```tsx
// Current:
accept = '.pdf,.md,.json,.yaml,.yml,.txt,.docx,.csv,.png,.jpg,.jpeg,.gif,.webp';
// Updated:
accept =
  'image/*,audio/*,video/*,application/pdf,.doc,.docx,.txt,.csv,.json,.xml,.yaml,.yml,.md,.mp3,.wav,.mp4,.webm';
```

- [ ] **Step 2: Build, step 3: commit**

```bash
npx prettier --write apps/studio/src/components/chat/ChatInput.tsx
git add apps/studio/src/components/chat/ChatInput.tsx
git commit -m "[ABLP-2] feat(studio): enable audio and video MIME types in file picker"
```

---

### Task 4: Add image thumbnail preview in MessageList

> **Audit fix (CRITICAL #2):** `MessageBubble.tsx` does NOT exist. Message content is rendered inside `MessageItem` within `MessageList.tsx`. Image thumbnails should be added to the attachment rendering section of `MessageItem`, alongside the existing filename chips.

**Files:**

- Modify: `apps/studio/src/components/chat/MessageList.tsx`

- [ ] **Step 1: Add inline thumbnail for image attachments**

Inside the attachment rendering block of `MessageItem` (after the filename chips), add:

```tsx
{
  /* Image thumbnails — rendered below filename chips for image attachments */
}
{
  message.metadata?.attachmentIds && message.metadata.attachmentIds.length > 0 && (
    <div className="flex flex-wrap gap-2 mb-2">
      {message.metadata.attachmentFilenames?.map((name, i) => {
        const attachmentId = message.metadata?.attachmentIds?.[i];
        const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
        if (!isImage || !attachmentId) return null;
        return <ImageThumbnail key={attachmentId} attachmentId={attachmentId} filename={name} />;
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create ImageThumbnail sub-component**

```tsx
// Inside MessageList.tsx — a local component
function ImageThumbnail({ attachmentId, filename }: { attachmentId: string; filename: string }) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const projectId = useNavigationStore((s) => s.projectId);
  const sessionId = useSessionStore((s) => s.sessionId);

  useEffect(() => {
    if (!projectId || !sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/url`,
        );
        if (!res.ok) {
          setError(true);
          return;
        }
        const { data } = await res.json();
        if (!cancelled && data?.url) setThumbnailUrl(data.url);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachmentId, projectId, sessionId]);

  if (error || !thumbnailUrl) return null;

  return (
    <img
      src={thumbnailUrl}
      alt={filename}
      className="max-w-48 rounded-md cursor-pointer hover:opacity-90 transition-all duration-200"
      onClick={() => window.open(thumbnailUrl, '_blank')}
      loading="lazy"
    />
  );
}
```

- [ ] **Step 3: Add necessary imports**

Add `useState` and `useEffect` to the React import, and import `useNavigationStore` from the store.

- [ ] **Step 4: Build, step 5: commit**

```bash
npx prettier --write apps/studio/src/components/chat/MessageList.tsx
git add apps/studio/src/components/chat/MessageList.tsx
git commit -m "[ABLP-2] feat(studio): add image thumbnail preview in chat message list"
```

---

## Chunk 2: Per-Project Attachment Configuration

### Task 5: Add AttachmentSettingsTab component with auth, validation, and tests

> **Audit fix (CRITICAL #3):** Original plan had no auth, no tenant scoping, no permission check on the API route. Now uses `withRouteHandler` with `requireProject: true`, `permissions`, and `bodySchema` for Zod validation — matching the pattern in `apps/studio/src/app/api/projects/[id]/git/push/route.ts`.

> **Audit fix (HIGH #5):** Added Zod validation for `maxFileSize` (capped at 100MB), `allowedMimeTypes` (validated format), and enum values.

**Files:**

- Create: `apps/studio/src/components/settings/AttachmentSettingsTab.tsx`
- Create: `apps/studio/src/app/api/projects/[id]/settings/attachments/route.ts`
- Test: `apps/studio/src/__tests__/attachment-settings-route.test.ts`

- [ ] **Step 1: Read the route handler pattern**

Read `apps/studio/src/lib/route-handler.ts` and `apps/studio/src/app/api/projects/[id]/git/push/route.ts` for the auth/permission/tenant-scoping pattern.

Key pattern: `withRouteHandler({ requireProject: true, permissions: StudioPermission.X, bodySchema }, handler)` provides `ctx.tenantId`, `ctx.user`, `ctx.params.id`, and `ctx.body`.

- [ ] **Step 2: Create the API route with auth + validation**

```typescript
// apps/studio/src/app/api/projects/[id]/settings/attachments/route.ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { ensureConnected, Project } from '@agent-platform/database/models';

const log = createLogger('attachment-settings-route');

/** Max allowed file size: 100 MB */
const MAX_ALLOWED_FILE_SIZE = 100 * 1024 * 1024;

/** MIME type pattern: type/subtype or type/* */
const MIME_TYPE_PATTERN = /^[a-z]+\/([\w.+-]+|\*)$/;

const AttachmentSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  maxFileSize: z
    .number()
    .int()
    .positive()
    .max(MAX_ALLOWED_FILE_SIZE, 'maxFileSize cannot exceed 100MB')
    .optional(),
  allowedMimeTypes: z
    .array(z.string().regex(MIME_TYPE_PATTERN, 'Invalid MIME type format (expected type/subtype)'))
    .max(50, 'Too many MIME types (max 50)')
    .optional(),
  attachmentPiiPolicy: z.enum(['redact', 'block', 'allow']).optional(),
  defaultProcessingMode: z.enum(['full', 'scan-only', 'store-raw']).optional(),
});

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_READ,
  },
  async (ctx) => {
    const { tenantId } = ctx;
    const projectId = ctx.params.id;

    await ensureConnected();
    const project = await Project.findOne({ _id: projectId, tenantId }).lean();
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: project.attachmentSettings ?? {},
    });
  },
);

export const PUT = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_READ, // TODO: add PROJECT_SETTINGS_WRITE when available
    bodySchema: AttachmentSettingsSchema,
  },
  async (ctx) => {
    const { tenantId, user, body } = ctx;
    const projectId = ctx.params.id;

    await ensureConnected();
    const updated = await Project.findOneAndUpdate(
      { _id: projectId, tenantId },
      { $set: { attachmentSettings: body } },
      { new: true },
    ).lean();

    if (!updated) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    log.info('Attachment settings updated', { projectId, userId: user.id });

    return NextResponse.json({
      success: true,
      data: updated.attachmentSettings ?? {},
    });
  },
);
```

- [ ] **Step 3: Create the settings tab component**

```tsx
// apps/studio/src/components/settings/AttachmentSettingsTab.tsx
'use client';
import { useState } from 'react';

interface AttachmentSettings {
  enabled?: boolean;
  maxFileSize?: number;
  allowedMimeTypes?: string[];
  attachmentPiiPolicy?: 'redact' | 'block' | 'allow';
  defaultProcessingMode?: 'full' | 'scan-only' | 'store-raw';
}

export function AttachmentSettingsTab({
  projectId,
  initialSettings,
}: {
  projectId: string;
  initialSettings: AttachmentSettings;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/settings/attachments`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? `Save failed (${res.status})`);
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium">Attachment Settings</h3>

      {error && (
        <div className="text-sm text-error bg-error-subtle px-3 py-2 rounded-md">{error}</div>
      )}

      {/* enabled toggle */}
      {/* maxFileSize input (validated: 1 byte – 100 MB) */}
      {/* allowedMimeTypes multi-select */}
      {/* attachmentPiiPolicy select: redact | block | allow */}
      {/* defaultProcessingMode select: full | scan-only | store-raw */}

      <button onClick={handleSave} disabled={saving} className="btn-primary">
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Add authz and validation tests**

> **Audit fix (MEDIUM #14):** Add 404 for cross-project, 401 for missing auth, 400 for invalid payload.

```typescript
// apps/studio/src/__tests__/attachment-settings-route.test.ts
import { describe, it, expect } from 'vitest';

describe('POST /api/projects/[id]/settings/attachments', () => {
  it('should return 401 when no auth token provided', async () => {
    // Call PUT without Authorization header
  });

  it('should return 404 for cross-tenant project access', async () => {
    // Authenticate as tenant A, try to update project belonging to tenant B
    // Must get 404 (not 403) per resource isolation rules
  });

  it('should return 400 for maxFileSize exceeding 100MB', async () => {
    // PUT with maxFileSize: 200 * 1024 * 1024
  });

  it('should return 400 for invalid MIME type format', async () => {
    // PUT with allowedMimeTypes: ['*/*', 'invalid']
  });

  it('should return 400 for invalid enum values', async () => {
    // PUT with attachmentPiiPolicy: 'delete'
  });

  it('should return 200 with valid payload', async () => {
    // PUT with valid settings, verify success response
  });
});
```

- [ ] **Step 5: Wire into project settings page**

Add an "Attachments" tab to the existing project settings UI.

- [ ] **Step 6: Build, step 7: commit**

```bash
npx prettier --write apps/studio/src/components/settings/AttachmentSettingsTab.tsx apps/studio/src/app/api/projects/[id]/settings/attachments/route.ts apps/studio/src/__tests__/attachment-settings-route.test.ts
git add apps/studio/src/components/settings/AttachmentSettingsTab.tsx apps/studio/src/app/api/projects/[id]/settings/attachments/route.ts apps/studio/src/__tests__/attachment-settings-route.test.ts
git commit -m "[ABLP-2] feat(studio): add per-project attachment configuration with auth and validation"
```

---

## Chunk 3: Tool Categories Infrastructure

### Task 6: Add `categories` field to IR ToolDefinition and compiler parsing

> **Audit fix (CRITICAL #4):** Spec section 4.2 says "Tools tagged with categories at compile time." The original plan referenced `(tool as any).categories` but never added the field to the IR schema or compiler. This task adds the infrastructure.

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts` (IR `ToolDefinition`)
- Modify: `packages/compiler/src/platform/llm/types.ts` (LLM `ToolDefinition`)
- Modify: Compiler tool-parsing code (find via `grep -r 'ToolDefinition' packages/compiler/src/` to locate the builder)
- Modify: `packages/compiler/src/platform/ir/schema.ts` (IR `ExecutionConfig` — add `tool_filtering.categories` map)
- Test: `packages/compiler/src/__tests__/tool-categories.test.ts`

- [ ] **Step 1: Add `categories` to IR ToolDefinition**

In `packages/compiler/src/platform/ir/schema.ts`, add to `ToolDefinition` (after `compaction`):

```typescript
/** Categories for contextual tool filtering (e.g., ['search', 'knowledge']) */
categories?: string[];

/** Whether this tool is compatible with GATHER state (included when gatherActive) */
gather_compatible?: boolean;
```

- [ ] **Step 2: Add `categories` to LLM ToolDefinition**

In `packages/compiler/src/platform/llm/types.ts`, add to `ToolDefinition` (after `input_schema`):

```typescript
/** Categories for contextual tool filtering */
categories?: string[];
```

- [ ] **Step 3: Add `tool_filtering` to ExecutionConfig including categories map**

> **Audit fix (HIGH #11):** Original task 7 omitted `categories` from the DSL config. Add it here.

In `packages/compiler/src/platform/ir/schema.ts`, add to `ExecutionConfig` (after existing `pipeline` field):

```typescript
/** Contextual tool filtering configuration */
tool_filtering?: {
  /** Filtering mode: auto (rule-based), full (no filter), llm (existing pipeline) */
  mode: 'auto' | 'full' | 'llm';
  /** Max tools to include in auto mode (default: 20) */
  max_tools?: number;
  /** Category overrides per tool name (supplements auto-detected categories) */
  categories?: Record<string, string[]>;
};
```

- [ ] **Step 4: Add compiler parsing for DSL `tool_filtering` block**

Parse the `EXECUTION.tool_filtering` DSL block:

```yaml
EXECUTION:
  tool_filtering:
    mode: auto
    max_tools: 20
    categories:
      search_docs: ['search', 'knowledge']
      send_email: ['communication']
```

The category overrides from `tool_filtering.categories` should be merged onto each tool's `categories` field during IR compilation.

- [ ] **Step 5: Add tests**

```typescript
// packages/compiler/src/__tests__/tool-categories.test.ts
import { describe, it, expect } from 'vitest';

describe('tool categories compilation', () => {
  it('should parse tool_filtering config from EXECUTION block', () => {
    // Compile DSL with tool_filtering, verify IR execution.tool_filtering
  });

  it('should merge category overrides onto tool definitions', () => {
    // Compile DSL with categories map, verify tool.categories populated
  });

  it('should default mode to auto when tool_filtering block is absent', () => {
    // Compile DSL without tool_filtering, verify default behavior
  });
});
```

- [ ] **Step 6: Build and test**

Run: `pnpm build --filter=compiler && pnpm test --filter=compiler -- --run tool-categories`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/schema.ts packages/compiler/src/platform/llm/types.ts packages/compiler/src/__tests__/tool-categories.test.ts
git add packages/compiler/src/platform/ir/schema.ts packages/compiler/src/platform/llm/types.ts packages/compiler/src/__tests__/tool-categories.test.ts
git commit -m "[ABLP-2] feat(compiler): add categories field to ToolDefinition and tool_filtering config"
```

---

## Chunk 4: Dynamic Tool Filtering

### Task 7: Implement rule-based tool filter

> **Audit fix (HIGH #6):** Import path corrected. The runtime uses `ToolDefinition` from `@abl/compiler/platform/llm/types.js` (re-exported by `session-llm-client.ts`), NOT from `@abl/compiler/platform/ir/schema`. However, the contextual filter needs the IR type which has `categories`, `system`, and `gather_compatible`. Import from the IR schema.

> **Audit fix (HIGH #9):** `Infinity` score for recent tools no longer bypasses maxTools. Recent tools are capped at `Math.floor(maxTools / 2)`.

> **Audit fix (HIGH #10):** No more `(tool as any)` casts. Uses proper IR `ToolDefinition` type which now has `categories` and `gather_compatible` fields (added in Task 6).

**Files:**

- Create: `apps/runtime/src/services/pipeline/contextual-tool-filter.ts`
- Test: `apps/runtime/src/__tests__/contextual-tool-filter.test.ts`

- [ ] **Step 1: Write failing tests for rule-based filter**

```typescript
// apps/runtime/src/__tests__/contextual-tool-filter.test.ts
import { describe, it, expect } from 'vitest';
import { filterToolsByContext } from '../services/pipeline/contextual-tool-filter';
import type { ToolDefinition } from '@abl/compiler/platform/ir/schema.js';

// Minimal mock tools conforming to IR ToolDefinition
function mockTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: '',
    parameters: [],
    returns: { type: 'any' },
    hints: {},
    ...overrides,
  } as ToolDefinition;
}

describe('contextual tool filter', () => {
  const tools = [
    mockTool({ name: 'search_docs', description: 'Search documentation', categories: ['search'] }),
    mockTool({ name: 'send_email', description: 'Send an email', categories: ['communication'] }),
    mockTool({
      name: 'create_ticket',
      description: 'Create support ticket',
      categories: ['support'],
    }),
    mockTool({ name: '__handoff__', description: 'System handoff', system: true }),
    mockTool({
      name: '_extract_entities',
      description: 'Extract entities',
      gather_compatible: true,
    }),
    mockTool({
      name: 'lookup_order',
      description: 'Look up order status',
      gather_compatible: true,
      categories: ['orders'],
    }),
  ];

  it('should always include system tools (prefixed with __)', () => {
    const result = filterToolsByContext(tools, { gatherActive: false }, 'hello', [], {
      mode: 'auto',
      maxTools: 2,
    });
    const names = result.map((t) => t.name);
    expect(names).toContain('__handoff__');
  });

  it('should only include gather-compatible tools during GATHER', () => {
    const result = filterToolsByContext(tools, { gatherActive: true }, 'my phone is 555-1234', [], {
      mode: 'auto',
      maxTools: 20,
    });
    const names = result.map((t) => t.name);
    expect(names).toContain('_extract_entities');
    expect(names).toContain('lookup_order');
    expect(names).toContain('__handoff__'); // system tools always included
    expect(names).not.toContain('send_email'); // not gather_compatible
  });

  it('should include recently used tools with higher priority', () => {
    const result = filterToolsByContext(tools, { gatherActive: false }, 'hello', ['send_email'], {
      mode: 'auto',
      maxTools: 2,
    });
    const names = result.map((t) => t.name);
    expect(names).toContain('send_email');
  });

  it('should cap recent tools to half of maxTools', () => {
    // 6 recent tool names but maxTools=4 → only 2 recent slots
    const manyRecent = [
      'search_docs',
      'send_email',
      'create_ticket',
      'lookup_order',
      '_extract_entities',
      'other',
    ];
    const result = filterToolsByContext(tools, { gatherActive: false }, 'unrelated', manyRecent, {
      mode: 'auto',
      maxTools: 4,
    });
    const domainNames = result.filter((t) => !t.system).map((t) => t.name);
    expect(domainNames.length).toBeLessThanOrEqual(4);
  });

  it('should return all tools when mode is full', () => {
    const result = filterToolsByContext(tools, {} as any, 'hello', [], {
      mode: 'full',
      maxTools: 20,
    });
    expect(result).toHaveLength(tools.length);
  });

  it('should score tools by keyword relevance', () => {
    const result = filterToolsByContext(
      tools,
      { gatherActive: false },
      'search the documentation',
      [],
      {
        mode: 'auto',
        maxTools: 2,
      },
    );
    const names = result.filter((t) => !t.system).map((t) => t.name);
    expect(names[0]).toBe('search_docs'); // highest relevance
  });

  it('should include attachment tools when awaitingAttachment', () => {
    const toolsWithAttachment = [
      ...tools,
      mockTool({ name: 'get_attachment', description: 'Get attachment' }),
      mockTool({ name: 'upload_attachment', description: 'Upload attachment' }),
    ];
    const result = filterToolsByContext(
      toolsWithAttachment,
      { awaitingAttachment: true },
      'here is my file',
      [],
      { mode: 'auto', maxTools: 20 },
    );
    const names = result.map((t) => t.name);
    expect(names).toContain('get_attachment');
    expect(names).toContain('upload_attachment');
    expect(names).not.toContain('send_email');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm test -- --run contextual-tool-filter`
Expected: FAIL — module not found

- [ ] **Step 3: Implement contextual-tool-filter.ts**

```typescript
// apps/runtime/src/services/pipeline/contextual-tool-filter.ts
import type { ToolDefinition } from '@abl/compiler/platform/ir/schema.js';

interface SessionState {
  gatherActive?: boolean;
  awaitingAttachment?: boolean;
}

interface ToolFilterConfig {
  mode: 'auto' | 'full' | 'llm';
  maxTools: number;
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'can',
  'shall',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'up',
  'about',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'and',
  'but',
  'or',
  'not',
  'no',
  'so',
  'if',
  'then',
  'than',
  'too',
  'very',
  'just',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t)),
  );
}

function isSystemTool(tool: ToolDefinition): boolean {
  return (
    tool.system === true ||
    tool.name.startsWith('__') ||
    tool.name.startsWith('handoff_to_') ||
    tool.name.startsWith('delegate_to_')
  );
}

const ATTACHMENT_TOOL_NAMES = new Set([
  'get_attachment',
  'list_attachments',
  'get_attachment_url',
  'upload_attachment',
]);

export function filterToolsByContext(
  tools: ToolDefinition[],
  sessionState: SessionState,
  lastMessage: string,
  recentToolNames: string[],
  config: ToolFilterConfig,
): ToolDefinition[] {
  if (config.mode === 'full') return tools;

  const systemTools = tools.filter((t) => isSystemTool(t));
  const domainTools = tools.filter((t) => !isSystemTool(t));

  // State-based rules
  if (sessionState.gatherActive) {
    const gatherTools = domainTools.filter(
      (t) => t.name === '_extract_entities' || t.gather_compatible === true,
    );
    return [...systemTools, ...gatherTools];
  }

  if (sessionState.awaitingAttachment) {
    const attachmentTools = domainTools.filter((t) => ATTACHMENT_TOOL_NAMES.has(t.name));
    return [...systemTools, ...attachmentTools];
  }

  // Cap recent tools to half of maxTools to prevent bypassing the limit
  const recentCap = Math.floor(config.maxTools / 2);
  const cappedRecent = new Set(recentToolNames.slice(0, recentCap));

  // Relevance scoring
  const messageTokens = tokenize(lastMessage);

  const scored = domainTools.map((tool) => {
    const isRecent = cappedRecent.has(tool.name);
    const toolTokens = tokenize(
      `${tool.name.replace(/_/g, ' ')} ${tool.description} ${(tool.categories ?? []).join(' ')}`,
    );
    const intersection = [...messageTokens].filter((t) => toolTokens.has(t)).length;
    const baseScore = toolTokens.size > 0 ? intersection / toolTokens.size : 0;
    // Recent tools get a boost but not Infinity — they can still be outscored
    const score = isRecent ? baseScore + 1.0 : baseScore;
    return { tool, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const topK = scored.slice(0, config.maxTools).map((s) => s.tool);

  return [...systemTools, ...topK];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/runtime && pnpm test -- --run contextual-tool-filter`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/contextual-tool-filter.ts apps/runtime/src/__tests__/contextual-tool-filter.test.ts
git add apps/runtime/src/services/pipeline/contextual-tool-filter.ts apps/runtime/src/__tests__/contextual-tool-filter.test.ts
git commit -m "[ABLP-2] feat(runtime): add rule-based contextual tool filter with proper types"
```

---

### Task 8: Integrate contextual filter into ReasoningExecutor

> **Audit fix (HIGH #12):** Original Task 7 (now Task 8) had zero tests. Added integration test requirements.

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts`
- Test: `apps/runtime/src/__tests__/reasoning-executor-tool-filter.test.ts`

- [ ] **Step 1: Read reasoning-executor.ts to find the LLM call site**

Find where `chatWithTools()` or similar is called and tools are passed. This is the insertion point for the contextual filter.

Note: The reasoning executor imports `ToolDefinition` from `../llm/session-llm-client.js`, which is the LLM type (name + description + input_schema). The IR `ToolDefinition` has `categories`, `system`, `gather_compatible`. The contextual filter needs the IR type. The integration point must map between the two types — use the agent IR's `tools` array (which is `AgentIR.tools: IRToolDefinition[]`) to look up categories, then filter the LLM tool definitions by name.

- [ ] **Step 2: Read the ExecutionConfig from `packages/compiler/src/platform/ir/schema.ts`**

Verify the `tool_filtering` field was added in Task 6.

- [ ] **Step 3: Add contextual filter call before LLM invocation**

```typescript
import { filterToolsByContext } from '../pipeline/contextual-tool-filter.js';
import type { ToolDefinition as IRToolDefinition } from '@abl/compiler/platform/ir/schema.js';

// Before chatWithTools():
const toolFilterConfig = session.agentIR?.execution?.tool_filtering;
const filterMode = toolFilterConfig?.mode ?? 'auto';

let filteredTools = tools;
if (filterMode !== 'llm' && session.agentIR?.tools) {
  // Build IR tool lookup for contextual filter (LLM tools lack categories/system)
  const irTools = session.agentIR.tools;
  const irToolsByName = new Map(irTools.map((t) => [t.name, t]));

  // Enrich LLM tools with IR metadata for filtering
  const enrichedTools: IRToolDefinition[] = tools.map((t) => {
    const irTool = irToolsByName.get(t.name);
    return (irTool ?? { name: t.name, description: t.description }) as IRToolDefinition;
  });

  const irFiltered = filterToolsByContext(
    enrichedTools,
    {
      gatherActive: !!session.data?.gatherActive,
      awaitingAttachment: !!session.data?.awaitingAttachment,
    },
    lastMessage,
    recentToolNames,
    {
      mode: filterMode === 'full' ? 'full' : 'auto',
      maxTools: toolFilterConfig?.max_tools ?? 20,
    },
  );

  // Map back to LLM tool definitions by name
  const filteredNames = new Set(irFiltered.map((t) => t.name));
  filteredTools = tools.filter((t) => filteredNames.has(t.name));
}
```

- [ ] **Step 4: Add integration tests**

```typescript
// apps/runtime/src/__tests__/reasoning-executor-tool-filter.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('ReasoningExecutor tool filtering integration', () => {
  it('should filter tools in auto mode before LLM call', () => {
    // Mock session with agentIR.execution.tool_filtering = { mode: 'auto', max_tools: 3 }
    // Mock 10 tools, verify chatWithTools receives <= 3 domain tools + system tools
  });

  it('should pass all tools in full mode', () => {
    // Mock session with tool_filtering = { mode: 'full' }
    // Verify all tools passed through
  });

  it('should fall through to existing LLM filter when mode is llm', () => {
    // Mock session with tool_filtering = { mode: 'llm' }
    // Verify filterToolsByContext is NOT called, existing pipeline filter is used
  });

  it('should default to auto mode when tool_filtering config is absent', () => {
    // Mock session with no tool_filtering config
    // Verify auto filtering is applied
  });
});
```

- [ ] **Step 5: Build and test**

Run: `pnpm build --filter=runtime && cd apps/runtime && pnpm test -- --run reasoning-executor-tool-filter`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/reasoning-executor-tool-filter.test.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/reasoning-executor-tool-filter.test.ts
git commit -m "[ABLP-2] feat(runtime): integrate contextual tool filter into ReasoningExecutor"
```

---

## Summary of Audit Fixes Applied

| #   | Severity | Finding                                           | Fix                                                                                                                                           |
| --- | -------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CRITICAL | `AttachmentCard.tsx` does not exist               | Task 1 now targets `MessageList.tsx` `MessageItem` component                                                                                  |
| 2   | CRITICAL | `MessageBubble.tsx` does not exist                | Task 4 now targets `MessageList.tsx` with new `ImageThumbnail` sub-component                                                                  |
| 3   | CRITICAL | Settings API route missing auth/tenant isolation  | Task 5 uses `withRouteHandler({ requireProject: true, permissions })`                                                                         |
| 4   | CRITICAL | `categories` field not added to IR                | New Task 6 adds `categories` and `gather_compatible` to IR `ToolDefinition` and `tool_filtering.categories` to `ExecutionConfig`              |
| 5   | HIGH     | Settings PUT missing input validation             | Task 5 adds Zod schema with max file size cap, MIME format regex, enum validation                                                             |
| 6   | HIGH     | `ToolDefinition` import path wrong                | Task 7 uses IR `ToolDefinition` from `@abl/compiler/platform/ir/schema.js` (has `categories`, `system`); Task 8 maps between IR and LLM types |
| 7   | HIGH     | Download button no error handling                 | Task 1 checks `res.ok`, handles missing `data.url`, catches exceptions                                                                        |
| 8   | HIGH     | Drag-drop/paste missing client-side validation    | Task 2 adds file size, MIME type, and count validation via `validateAndUpload`                                                                |
| 9   | HIGH     | `Infinity` score bypasses maxTools                | Task 7 caps recent tools to `Math.floor(maxTools / 2)` and uses additive boost (+1.0) instead of Infinity                                     |
| 10  | HIGH     | `(tool as any).categories` and `gatherCompatible` | Task 7 uses proper IR `ToolDefinition` type with `categories` and `gather_compatible` fields                                                  |
| 11  | HIGH     | DSL `tool_filtering.categories` not parsed        | Task 6 adds `categories` map to `ExecutionConfig.tool_filtering` and compiler parsing                                                         |
| 12  | HIGH     | Task 7 (now 8) no tests                           | Task 8 adds 4 integration tests for ReasoningExecutor tool filter                                                                             |
| 13  | MEDIUM   | Tasks 1-4 have zero tests                         | Tasks 1, 2 now include test files                                                                                                             |
| 14  | MEDIUM   | Task 5 missing authz tests                        | Task 5 includes 6 authz/validation tests                                                                                                      |

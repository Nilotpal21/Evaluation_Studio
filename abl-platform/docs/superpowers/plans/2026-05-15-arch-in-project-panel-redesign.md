# Arch In-Project Panel Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the in-project Arch overlay: pin the Journal tab as always-first-and-non-closeable, replace the fragile two-button artifact toggle with a single always-visible CTA, widen the artifact panel from 74vw to 85vw, and bring the in-project chat footer to full visual and functional parity with the onboarding footer.

**Architecture:** Three focused commits — prep (i18n keys + store helper), layout (toggle + width + journal pin), and footer parity (new `useComposerAttachments` hook + wiring). No new API routes, no store schema changes, no onboarding page changes.

**Tech Stack:** React, Zustand, Next-intl, Tailwind CSS, Lucide icons, `ChatInputBar` (`apps/studio/src/components/chat/ChatInputBar.tsx`), `uploadFiles` (`apps/studio/src/lib/arch/upload-files.ts`)

---

## File map

| File                                                                            | Action     | Notes                                                                                         |
| ------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `packages/i18n/locales/en/studio.json`                                          | Modify     | Add `show_artifacts`, `hide_artifacts` keys to `arch_in_project` namespace                    |
| `apps/studio/src/lib/arch-ai/store/arch-ai-store.ts`                            | Modify     | Add `ensureJournalFirst` action; call it from `addTab`                                        |
| `apps/studio/src/lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx` | Modify     | Show `Pin` icon on journal core tab; confirm no close button exists on non-closeable tabs     |
| `apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx`           | Modify     | Replace two-button toggle, bump width to `85vw`, call `ensureJournalFirst` on open, wire hook |
| `apps/studio/src/lib/arch-ai/hooks/use-composer-attachments.ts`                 | **Create** | New hook: attachment state + upload lifecycle                                                 |
| `apps/studio/src/__tests__/arch-ai/ensure-journal-first.test.ts`                | **Create** | Pure-function unit tests for `ensureJournalFirst`                                             |
| `apps/studio/src/__tests__/arch-ai/use-composer-attachments.test.ts`            | **Create** | Hook unit tests (happy path, max file, failure)                                               |

---

## Task 1 — Add i18n keys

**Files:**

- Modify: `packages/i18n/locales/en/studio.json`

These two strings live at the cursor in `arch_in_project`. Insert them after `"expand": "Expand"` (line ~5221).

- [ ] **Step 1: Open the i18n file and add the two keys**

Find this block (around line 5218):

```json
"close": "Close",
"collapse": "Collapse",
"expand": "Expand",
```

Change it to:

```json
"close": "Close",
"collapse": "Collapse",
"expand": "Expand",
"show_artifacts": "Show artifacts",
"hide_artifacts": "Hide artifacts",
```

- [ ] **Step 2: Run prettier**

```bash
npx prettier --write packages/i18n/locales/en/studio.json
```

- [ ] **Step 3: Build the i18n package to verify no JSON parse errors**

```bash
pnpm build --filter=@abl/i18n
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/locales/en/studio.json
git commit -m "[ABLP-162] feat(arch-ai): add show/hide artifacts i18n keys"
```

---

## Task 2 — `ensureJournalFirst` store action

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/store/arch-ai-store.ts`
- Create: `apps/studio/src/__tests__/arch-ai/ensure-journal-first.test.ts`

The goal: whenever `artifactTabs` is mutated, the journal tab is guaranteed to be at index 0.

### 2a — Write the failing tests first

- [ ] **Step 1: Create the test file**

`apps/studio/src/__tests__/arch-ai/ensure-journal-first.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { ArtifactTab } from '@/lib/arch-ai/store/arch-ai-store';

// Import the helper we're about to write — will fail until Task 2b.
import { ensureJournalFirst } from '@/lib/arch-ai/store/arch-ai-store';

function makeTab(type: ArtifactTab['type'], id: string): ArtifactTab {
  return { id, type, label: type, data: null, version: 1, toolCallId: '' };
}

describe('ensureJournalFirst', () => {
  it('returns empty array unchanged', () => {
    expect(ensureJournalFirst([])).toEqual([]);
  });

  it('returns array unchanged when journal is already first', () => {
    const tabs = [makeTab('journal', 'j1'), makeTab('plan', 'p1')];
    const result = ensureJournalFirst(tabs);
    expect(result[0].type).toBe('journal');
    expect(result).toHaveLength(2);
  });

  it('moves journal to front when it is not first', () => {
    const tabs = [makeTab('plan', 'p1'), makeTab('journal', 'j1'), makeTab('health', 'h1')];
    const result = ensureJournalFirst(tabs);
    expect(result[0].type).toBe('journal');
    expect(result[0].id).toBe('j1');
    expect(result).toHaveLength(3);
  });

  it('does not create a journal tab if none exists', () => {
    const tabs = [makeTab('plan', 'p1'), makeTab('health', 'h1')];
    const result = ensureJournalFirst(tabs);
    expect(result[0].type).toBe('plan');
    expect(result.some((t) => t.type === 'journal')).toBe(false);
  });

  it('is idempotent — calling twice gives same result', () => {
    const tabs = [makeTab('plan', 'p1'), makeTab('journal', 'j1')];
    expect(ensureJournalFirst(ensureJournalFirst(tabs))).toEqual(ensureJournalFirst(tabs));
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm test --filter=@abl/studio -- ensure-journal-first --skip-build 2>&1 | tail -20
```

Expected: FAIL — `ensureJournalFirst is not a function` (or similar import error).

### 2b — Implement `ensureJournalFirst`

- [ ] **Step 3: Add the helper and store action**

In `apps/studio/src/lib/arch-ai/store/arch-ai-store.ts`:

**After the existing imports, before the `MAX_TABS` constant, add this exported pure helper:**

```typescript
/** Moves the journal tab to index 0 without creating one if absent. Idempotent. */
export function ensureJournalFirst(tabs: ArtifactTab[]): ArtifactTab[] {
  const journalIdx = tabs.findIndex((t) => t.type === 'journal');
  if (journalIdx <= 0) return tabs; // already first (or absent)
  const reordered = [...tabs];
  const [journal] = reordered.splice(journalIdx, 1);
  reordered.unshift(journal);
  return reordered;
}
```

**Then, inside the `addTab` action** (currently at line ~350), after `set((state) => { ... })` produces the new `tabs` array, wrap the final `tabs` with `ensureJournalFirst`:

Find the block that builds `newTab` and appends it (lines ~374-388):

```typescript
// BEFORE (the return statement inside set()):
return {
  artifactTabs: tabs,
  activeTabId: id,
  showArtifactPanel: true,
};
```

Change to:

```typescript
return {
  artifactTabs: ensureJournalFirst(tabs),
  activeTabId: id,
  showArtifactPanel: true,
};
```

Also apply to the "replace existing tab" branch (lines ~360-372), the existing return:

```typescript
return {
  artifactTabs: tabs,
  activeTabId: state.activeTabId ?? existing.id,
  showArtifactPanel: true,
};
```

Change to:

```typescript
return {
  artifactTabs: ensureJournalFirst(tabs),
  activeTabId: state.activeTabId ?? existing.id,
  showArtifactPanel: true,
};
```

- [ ] **Step 4: Run prettier**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/store/arch-ai-store.ts
```

- [ ] **Step 5: Build to verify no type errors**

```bash
pnpm build --filter=@abl/studio --skip-build 2>&1 | grep -E "error|Error" | head -10
```

Actually run incremental typecheck:

```bash
cd apps/studio && npx tsc --noEmit 2>&1 | grep "error TS" | head -10
```

Expected: 0 errors.

- [ ] **Step 6: Run the tests — they should pass now**

```bash
pnpm test --filter=@abl/studio -- ensure-journal-first --skip-build 2>&1 | tail -10
```

Expected: 5 passing.

- [ ] **Step 7: Commit**

```bash
git add apps/studio/src/lib/arch-ai/store/arch-ai-store.ts \
        apps/studio/src/__tests__/arch-ai/ensure-journal-first.test.ts
git commit -m "[ABLP-162] refactor(arch-ai): add ensureJournalFirst store helper"
```

---

## Task 3 — Pin journal tab visually in `InProjectArtifactPanel`

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx`

Currently the `coreTabs` (non-closeable) map renders a button without a close button. The journal tab is already protected from closing by `NON_CLOSEABLE_TABS`. We just need to add the pin visual affordance on journal specifically.

- [ ] **Step 1: Add `Pin` to the Lucide import**

Line 6 currently: `import { X } from 'lucide-react';`

Change to:

```typescript
import { Pin, X } from 'lucide-react';
```

- [ ] **Step 2: Update the core tab render to show the pin icon for journal**

Find the `coreTabs.map` block at lines ~127-143:

```tsx
{
  coreTabs.map((tab) => (
    <button
      key={tab.id}
      onClick={() => handleTabClick(tab.id)}
      className={clsx(
        'relative flex items-center gap-1.5 whitespace-nowrap rounded-t-md px-3 py-2 text-xs font-medium transition-colors',
        activeTab?.id === tab.id
          ? 'bg-background text-foreground border border-border border-b-background -mb-px'
          : 'text-foreground-muted hover:text-foreground hover:bg-background-muted/50',
      )}
    >
      {tab.label}
      {tab.isNew && (
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent animate-pulse" />
      )}
    </button>
  ));
}
```

Change to:

```tsx
{
  coreTabs.map((tab) => (
    <button
      key={tab.id}
      onClick={() => handleTabClick(tab.id)}
      className={clsx(
        'relative flex items-center gap-1.5 whitespace-nowrap rounded-t-md px-3 py-2 text-xs font-medium transition-colors',
        activeTab?.id === tab.id
          ? 'bg-background text-foreground border border-border border-b-background -mb-px'
          : 'text-foreground-muted hover:text-foreground hover:bg-background-muted/50',
      )}
    >
      {tab.type === 'journal' && <Pin className="h-2.5 w-2.5 opacity-60" aria-hidden="true" />}
      {tab.label}
      {tab.isNew && (
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent animate-pulse" />
      )}
    </button>
  ));
}
```

- [ ] **Step 3: Run prettier and typecheck**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx
cd apps/studio && npx tsc --noEmit 2>&1 | grep "error TS" | head -5
```

Expected: 0 errors.

- [ ] **Step 4: Commit (will be bundled with Task 4)**

Hold this change — commit together with Task 4.

---

## Task 4 — Replace two-button toggle + bump overlay width

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx`

### 4a — Width constant

- [ ] **Step 1: Bump `OVERLAY_WIDTHS.artifacts` to 85vw**

Find lines 49-53:

```typescript
const OVERLAY_WIDTHS: Record<Exclude<OverlayState, 'closed'>, string> = {
  chat: 'w-[540px]',
  artifacts: 'w-[74vw]',
  ide: 'w-[90vw]',
};
```

Change to:

```typescript
const OVERLAY_WIDTHS: Record<Exclude<OverlayState, 'closed'>, string> = {
  chat: 'w-[540px]',
  artifacts: 'w-[85vw]',
  ide: 'w-[90vw]',
};
```

- [ ] **Step 2: Fix the stale doc comment at lines 78-87**

Find:

```typescript
/**
 * ArchOverlay — in-project Arch panel with expandable layout.
 *
 * 3 states:
 * - chat: 400px right panel (default on open)
 * - artifacts: artifact panel + 400px chat (expands left)
 * - ide: file tree + artifact + 400px chat (full overlay)
 *
 * No background dimming — project page stays fully interactive.
 */
```

Change to:

```typescript
/**
 * ArchOverlay — in-project Arch panel with expandable layout.
 *
 * 3 states:
 * - chat: 540px right panel (default on open)
 * - artifacts: artifact panel + 540px chat (expands to 85vw)
 * - ide: artifact panel + 540px chat (expands to 90vw, no toggle UI)
 *
 * No background dimming — project page stays fully interactive.
 */
```

### 4b — Replace the two toggle buttons with one CTA

The two existing buttons live at lines 822-839:

```tsx
{
  !resumeGateVisible && visibleOverlayState === 'chat' && (
    <button
      onClick={() => setOverlayState('artifacts')}
      className="rounded-lg p-1.5 text-foreground-muted transition-colors hover:bg-background-muted hover:text-foreground"
      title={t('expand')}
    >
      <PanelLeftOpen className="h-4 w-4" />
    </button>
  );
}
{
  showArtifacts && (
    <button
      onClick={() => setOverlayState('chat')}
      className="rounded-lg p-1.5 text-foreground-muted transition-colors hover:bg-background-muted hover:text-foreground"
      title={t('collapse')}
    >
      <PanelLeftClose className="h-4 w-4" />
    </button>
  );
}
```

- [ ] **Step 3: Replace both buttons with the single always-visible CTA**

Replace the entire block above with:

```tsx
<button
  onClick={() => setOverlayState(showArtifacts ? 'chat' : 'artifacts')}
  aria-pressed={showArtifacts}
  data-testid="arch-artifacts-toggle"
  title={showArtifacts ? t('hide_artifacts') : t('show_artifacts')}
  className={clsx(
    'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
    showArtifacts
      ? 'border-accent/40 bg-accent-subtle text-accent-foreground'
      : 'border-border bg-background-muted text-foreground-muted hover:bg-background-elevated hover:text-foreground',
  )}
>
  {showArtifacts ? (
    <PanelLeftClose className="h-3.5 w-3.5" />
  ) : (
    <PanelLeftOpen className="h-3.5 w-3.5" />
  )}
  <span>{showArtifacts ? t('hide_artifacts') : t('show_artifacts')}</span>
</button>
```

Note: `PanelLeftOpen` and `PanelLeftClose` are already imported. `clsx` is already imported. `showArtifacts` is already derived at line 567.

### 4c — Call `ensureJournalFirst` on overlay open

The `ensureJournalTab` callback (lines 164-169) seeds a journal tab when absent but doesn't guarantee it's first. Update it to also enforce ordering.

- [ ] **Step 4: Import `ensureJournalFirst` at the top of ArchOverlay.tsx**

Find the existing arch-ai store import:

```typescript
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
```

Change to:

```typescript
import { useArchAIStore, ensureJournalFirst } from '@/lib/arch-ai/store/arch-ai-store';
```

- [ ] **Step 5: Update `ensureJournalTab` to also enforce position**

Find lines 164-169:

```typescript
const ensureJournalTab = useCallback(() => {
  const store = useArchAIStore.getState();
  if (!store.artifactTabs.find((tab) => tab.type === 'journal')) {
    store.addTab({ type: 'journal', data: null, label: 'Journal', toolCallId: '' });
  }
}, []);
```

Change to:

```typescript
const ensureJournalTab = useCallback(() => {
  const store = useArchAIStore.getState();
  if (!store.artifactTabs.find((tab) => tab.type === 'journal')) {
    store.addTab({ type: 'journal', data: null, label: 'Journal', toolCallId: '' });
  } else {
    useArchAIStore.setState((state) => ({
      artifactTabs: ensureJournalFirst(state.artifactTabs),
    }));
  }
}, []);
```

- [ ] **Step 6: Run prettier and typecheck**

```bash
npx prettier --write \
  apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx \
  apps/studio/src/lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx
cd apps/studio && npx tsc --noEmit 2>&1 | grep "error TS" | head -10
```

Expected: 0 errors.

- [ ] **Step 7: Commit Tasks 3 + 4 together**

```bash
git add \
  apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx \
  apps/studio/src/lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx
git commit -m "[ABLP-162] feat(arch-ai): pin journal tab, persistent artifact toggle, widen to 85vw"
```

---

## Task 5 — Create `useComposerAttachments` hook

**Files:**

- Create: `apps/studio/src/lib/arch-ai/hooks/use-composer-attachments.ts`
- Create: `apps/studio/src/__tests__/arch-ai/use-composer-attachments.test.ts`

This hook manages composer attachment lifecycle for in-project use. It:

1. Holds `composerAttachments: ComposerAttachmentDraft[]` state.
2. Validates and uploads files when the user attaches them via `handleComposerAttachFiles`.
3. Provides `removeComposerAttachment` and `clearComposerAttachments`.
4. Derives `composerBlobRefs` — the ready-to-send blob references for `send()`.

`ComposerAttachmentDraft` is defined inside `arch/page.tsx` today. We re-declare it in the hook (it's a narrow interface; duplicating is cleaner than exporting from `page.tsx`).

### 5a — Tests first

- [ ] **Step 1: Create the test file**

`apps/studio/src/__tests__/arch-ai/use-composer-attachments.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useComposerAttachments } from '@/lib/arch-ai/hooks/use-composer-attachments';
import { ARCH_AI_FILES } from '@/lib/arch-ai/constants';

// Only mock external upload — all validation is real.
vi.mock('@/lib/arch/upload-files', () => ({
  uploadFiles: vi.fn(),
}));
vi.mock('@/lib/arch-ai/file-mime', () => ({
  resolveAcceptedArchUploadMimeType: vi.fn((name: string) =>
    name.endsWith('.txt') ? 'text/plain' : null,
  ),
  normalizeArchUploadMimeType: vi.fn((name: string) =>
    name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream',
  ),
}));

import { uploadFiles } from '@/lib/arch/upload-files';

function makeFile(name: string, size = 100): File {
  return new File(['x'.repeat(size)], name, { type: 'text/plain' });
}

const SESSION_ID = 'sess-001';
const getSessionId = async () => SESSION_ID;

describe('useComposerAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uploadFiles).mockResolvedValue([
      { blobId: 'blob-001', size: 100, mediaType: 'text/plain' } as any,
    ]);
  });

  it('starts with empty attachments', () => {
    const { result } = renderHook(() => useComposerAttachments({ getSessionId }));
    expect(result.current.composerAttachments).toEqual([]);
    expect(result.current.composerBlobRefs).toEqual([]);
  });

  it('adds attachment and marks ready after upload', async () => {
    const { result } = renderHook(() => useComposerAttachments({ getSessionId }));
    await act(async () => {
      await result.current.handleComposerAttachFiles([makeFile('test.txt')]);
    });
    expect(result.current.composerAttachments).toHaveLength(1);
    expect(result.current.composerAttachments[0].status).toBe('ready');
    expect(result.current.composerBlobRefs).toHaveLength(1);
    expect(result.current.composerBlobRefs[0].blobId).toBe('blob-001');
  });

  it('marks attachment failed when upload throws', async () => {
    vi.mocked(uploadFiles).mockRejectedValueOnce(new Error('network error'));
    const { result } = renderHook(() => useComposerAttachments({ getSessionId }));
    await act(async () => {
      await result.current.handleComposerAttachFiles([makeFile('test.txt')]);
    });
    expect(result.current.composerAttachments[0].status).toBe('failed');
    expect(result.current.composerAttachments[0].detail).toBe('network error');
  });

  it('rejects files exceeding the max count', async () => {
    const { result } = renderHook(() => useComposerAttachments({ getSessionId }));
    const files = Array.from({ length: ARCH_AI_FILES.MAX_FILES + 2 }, (_, i) =>
      makeFile(`file${i}.txt`),
    );
    await act(async () => {
      await result.current.handleComposerAttachFiles(files);
    });
    expect(result.current.composerAttachments).toHaveLength(ARCH_AI_FILES.MAX_FILES);
  });

  it('removeComposerAttachment removes the specified attachment', async () => {
    const { result } = renderHook(() => useComposerAttachments({ getSessionId }));
    await act(async () => {
      await result.current.handleComposerAttachFiles([makeFile('test.txt')]);
    });
    const id = result.current.composerAttachments[0].id;
    act(() => {
      result.current.removeComposerAttachment(id);
    });
    expect(result.current.composerAttachments).toHaveLength(0);
  });

  it('clearComposerAttachments empties the list', async () => {
    const { result } = renderHook(() => useComposerAttachments({ getSessionId }));
    await act(async () => {
      await result.current.handleComposerAttachFiles([makeFile('test.txt')]);
    });
    act(() => {
      result.current.clearComposerAttachments();
    });
    expect(result.current.composerAttachments).toHaveLength(0);
  });

  it('skips upload when getSessionId returns null', async () => {
    const { result } = renderHook(() => useComposerAttachments({ getSessionId: async () => null }));
    await act(async () => {
      await result.current.handleComposerAttachFiles([makeFile('test.txt')]);
    });
    expect(uploadFiles).not.toHaveBeenCalled();
    // Attachment is added as 'failed' — no session to upload to
    expect(result.current.composerAttachments[0].status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run tests — should fail**

```bash
pnpm test --filter=@abl/studio -- use-composer-attachments --skip-build 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '@/lib/arch-ai/hooks/use-composer-attachments'`.

### 5b — Implement the hook

- [ ] **Step 3: Create the hook file**

`apps/studio/src/lib/arch-ai/hooks/use-composer-attachments.ts`:

```typescript
'use client';

import { useState, useCallback } from 'react';
import type { ChatInputAttachment } from '@/components/chat/ChatInputBar';
import { uploadFiles } from '@/lib/arch/upload-files';
import { ARCH_AI_FILES } from '@/lib/arch-ai/constants';
import {
  resolveAcceptedArchUploadMimeType,
  normalizeArchUploadMimeType,
} from '@/lib/arch-ai/file-mime';

export interface ComposerAttachmentDraft extends ChatInputAttachment {
  blobId?: string;
}

export interface ComposerBlobRef {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

interface UseComposerAttachmentsOptions {
  /** Returns the session ID to upload to, or null if no session is available. */
  getSessionId: () => Promise<string | null>;
}

interface UseComposerAttachmentsReturn {
  composerAttachments: ComposerAttachmentDraft[];
  composerBlobRefs: ComposerBlobRef[];
  handleComposerAttachFiles: (files: File[]) => Promise<void>;
  removeComposerAttachment: (attachmentId: string) => void;
  clearComposerAttachments: () => void;
}

function validateFile(file: File): { mediaType: string } | { error: string } {
  if (file.size <= 0) return { error: 'File is empty.' };
  if (file.size > ARCH_AI_FILES.MAX_FILE_SIZE_BYTES) {
    return {
      error: `File exceeds ${(ARCH_AI_FILES.MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0)}MB limit.`,
    };
  }
  const mediaType = resolveAcceptedArchUploadMimeType(file.name, file.type);
  if (!mediaType) {
    return {
      error: `Unsupported file type. Allowed: ${ARCH_AI_FILES.ACCEPTED_UPLOAD_EXTENSIONS.join(', ')}`,
    };
  }
  return { mediaType };
}

export function useComposerAttachments({
  getSessionId,
}: UseComposerAttachmentsOptions): UseComposerAttachmentsReturn {
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachmentDraft[]>([]);

  const composerBlobRefs: ComposerBlobRef[] = composerAttachments
    .filter(
      (a): a is ComposerAttachmentDraft & { blobId: string } =>
        a.status === 'ready' && typeof a.blobId === 'string',
    )
    .map((a) => ({
      blobId: a.blobId,
      name: a.name,
      type: a.mediaType,
      size: a.size,
    }));

  const handleComposerAttachFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      setComposerAttachments((prev) => {
        const remaining = Math.max(0, ARCH_AI_FILES.MAX_FILES - prev.length);
        const accepted = files.slice(0, remaining);

        const newDrafts: ComposerAttachmentDraft[] = accepted.map((file) => {
          const validation = validateFile(file);
          if ('error' in validation) {
            return {
              id: crypto.randomUUID(),
              name: file.name,
              size: file.size,
              mediaType: normalizeArchUploadMimeType(file.name, file.type),
              status: 'failed' as const,
              detail: validation.error,
            };
          }
          return {
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            mediaType: validation.mediaType,
            status: 'uploading' as const,
            progress: 0,
          };
        });

        return [...prev, ...newDrafts];
      });

      // Upload valid files after state is updated
      // We get the drafts we just created from the closure; re-derive from files
      const sessionId = await getSessionId();

      const uploadTasks = files.slice(0, Math.max(0, ARCH_AI_FILES.MAX_FILES)).map(async (file) => {
        const validation = validateFile(file);
        if ('error' in validation) return; // already marked failed above

        if (!sessionId) {
          setComposerAttachments((prev) =>
            prev.map((a) =>
              a.name === file.name && a.size === file.size && a.status === 'uploading'
                ? { ...a, status: 'failed', detail: 'No active session to upload to.' }
                : a,
            ),
          );
          return;
        }

        try {
          const [result] = await uploadFiles(sessionId, [file], (_i, progress) => {
            setComposerAttachments((prev) =>
              prev.map((a) =>
                a.name === file.name && a.size === file.size && a.status === 'uploading'
                  ? { ...a, progress }
                  : a,
              ),
            );
          });
          setComposerAttachments((prev) =>
            prev.map((a) =>
              a.name === file.name && a.size === file.size && a.status === 'uploading'
                ? { ...a, status: 'ready', blobId: result.blobId, progress: undefined }
                : a,
            ),
          );
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err);
          setComposerAttachments((prev) =>
            prev.map((a) =>
              a.name === file.name && a.size === file.size && a.status === 'uploading'
                ? { ...a, status: 'failed', detail, progress: undefined }
                : a,
            ),
          );
        }
      });

      await Promise.all(uploadTasks);
    },
    [getSessionId],
  );

  const removeComposerAttachment = useCallback((attachmentId: string) => {
    setComposerAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
  }, []);

  const clearComposerAttachments = useCallback(() => {
    setComposerAttachments([]);
  }, []);

  return {
    composerAttachments,
    composerBlobRefs,
    handleComposerAttachFiles,
    removeComposerAttachment,
    clearComposerAttachments,
  };
}
```

- [ ] **Step 4: Run prettier and typecheck**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/hooks/use-composer-attachments.ts
cd apps/studio && npx tsc --noEmit 2>&1 | grep "error TS" | head -10
```

Expected: 0 errors.

- [ ] **Step 5: Run the hook tests — should pass now**

```bash
pnpm test --filter=@abl/studio -- use-composer-attachments --skip-build 2>&1 | tail -15
```

Expected: 6 passing.

- [ ] **Step 6: Commit the hook**

```bash
git add \
  apps/studio/src/lib/arch-ai/hooks/use-composer-attachments.ts \
  apps/studio/src/__tests__/arch-ai/use-composer-attachments.test.ts
git commit -m "[ABLP-162] refactor(arch-ai): add useComposerAttachments hook for in-project attachment lifecycle"
```

---

## Task 6 — Wire footer parity in `ArchOverlay`

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx`

### 6a — Import and instantiate the hook

- [ ] **Step 1: Add import for the hook**

After the existing `import { useArchAIStore, ensureJournalFirst }` line, add:

```typescript
import { useComposerAttachments } from '@/lib/arch-ai/hooks/use-composer-attachments';
```

- [ ] **Step 2: Instantiate the hook inside the component**

Place this hook call **just before `handleSendWithFiles`** (around line 495, after `ensureWritableProjectSession` is defined at line 444). React hooks must be called at the top level of the component function; the `getSessionId` closure captures `ensureWritableProjectSession` by reference — it is resolved at call time, not at hook-instantiation time.

```typescript
const {
  composerAttachments,
  composerBlobRefs,
  handleComposerAttachFiles,
  removeComposerAttachment,
  clearComposerAttachments,
} = useComposerAttachments({
  getSessionId: async () => {
    const s = await ensureWritableProjectSession();
    return s?.id ?? null;
  },
});
```

Note: `ensureWritableProjectSession` is defined at line 444 as a `useCallback` — it must already be defined before this `useComposerAttachments` call appears in the source (not a React requirement, but required for TypeScript to resolve the name).

### 6b — Update `handleSendWithFiles` to consume blobRefs from hook

- [ ] **Step 3: Update `handleSendWithFiles`**

Find `handleSendWithFiles` at lines 496-537. The current logic uploads raw `files` and calls `send(text, undefined, refs)`. With controlled attachments, `files` will always be `[]`. We extend it to also send the pre-uploaded `composerBlobRefs`.

Replace the entire `handleSendWithFiles` with:

```typescript
const handleSendWithFiles = useCallback(
  async (text: string, files: File[]) => {
    const trimmedText = text.trim();
    const hasPendingAttachments = composerAttachments.some(
      (a) => a.status === 'uploading' || a.status === 'processing',
    );
    if (
      (!trimmedText && files.length === 0 && composerBlobRefs.length === 0) ||
      hasPendingAttachments ||
      sessionTransitioning ||
      (chatState !== 'idle' && chatState !== 'widget_pending')
    ) {
      return;
    }

    onUserSent();
    setUploadError(null);
    setSessionError(null);

    try {
      const activeSession = await ensureWritableProjectSession();
      if (!activeSession?.id) return;

      // Files passed directly (drag-drop on chat, legacy path) — upload inline
      const directRefs =
        files.length > 0
          ? (await uploadFiles(activeSession.id, files, undefined, { waitForReady: true })).map(
              (r, i) => ({
                blobId: r.blobId,
                name: files[i]?.name ?? '',
                type: files[i]
                  ? normalizeArchUploadMimeType(files[i].name, files[i].type)
                  : undefined,
                size: files[i]?.size,
              }),
            )
          : [];

      const allRefs = [...composerBlobRefs, ...directRefs];
      await send(trimmedText, undefined, allRefs.length > 0 ? allRefs : undefined);
      clearComposerAttachments();
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  },
  [
    chatState,
    clearComposerAttachments,
    composerAttachments,
    composerBlobRefs,
    ensureWritableProjectSession,
    onUserSent,
    send,
    sessionTransitioning,
  ],
);
```

### 6c — Update the chat input JSX

- [ ] **Step 4: Replace the compact footer with the onboarding-parity footer**

Find the footer block at lines 723-770:

```tsx
{/* Input */}
<div className="px-3 pb-3">
  <ChatInputBar
    variant="compact"
    showModelLabel={false}
    onSend={handleSendWithFiles}
    disabled={...}
    ...
    footer={
      resumeGateVisible ? (
        <p className="px-1 pt-2 text-[11px] leading-relaxed text-foreground-subtle">
          {t('resume_input_hint')}
        </p>
      ) : null
    }
  />
</div>
```

Change the wrapper and props:

```tsx
{
  /* Input — onboarding-parity: default variant, px-6 pb-6 pt-3, attachments */
}
<div className="shrink-0 px-6 pb-6 pt-3">
  <ChatInputBar
    showModelLabel={false}
    onSend={handleSendWithFiles}
    attachments={composerAttachments}
    onAttachFiles={(files) => void handleComposerAttachFiles(files)}
    onRemoveAttachment={removeComposerAttachment}
    disabled={
      !initialized ||
      sessionTransitioning ||
      chatState === 'streaming' ||
      isBuildInProgress ||
      buildLockActive ||
      !['idle', 'widget_pending'].includes(chatState)
    }
    disabledReason={
      !initialized
        ? 'connecting'
        : buildLockActive
          ? 'generating'
          : isBuildInProgress
            ? 'generating'
            : chatState === 'streaming'
              ? 'streaming'
              : undefined
    }
    isStreaming={chatState === 'streaming' || isBuildInProgress || buildLockActive}
    onStop={stop}
    placeholder={
      chatState === 'widget_pending'
        ? 'Or type something else...'
        : resumeGateVisible
          ? t('resume_input_placeholder')
          : chatState === 'idle'
            ? 'Ask about this project...'
            : undefined
    }
    ariaLabel="Ask about this project"
    inputTestId="arch-input"
    sendButtonTestId="arch-send"
    footer={
      resumeGateVisible ? (
        <p className="px-1 pt-2 text-[11px] leading-relaxed text-foreground-subtle">
          {t('resume_input_hint')}
        </p>
      ) : null
    }
  />
</div>;
```

- [ ] **Step 5: Run prettier and typecheck**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx
cd apps/studio && npx tsc --noEmit 2>&1 | grep "error TS" | head -10
```

Expected: 0 errors. If there are errors about `composerBlobRefs` not existing as a `send()` parameter type, check `send`'s signature in `useArchChat` — it accepts `BlobRef[] | undefined` as the third arg.

- [ ] **Step 6: Build studio to confirm no build errors**

```bash
pnpm build --filter=@abl/studio 2>&1 | grep -E "^.*(error|Error)" | head -10
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx
git commit -m "[ABLP-162] feat(arch-ai): bring in-project chat footer to onboarding parity"
```

---

## Task 7 — Verify end-to-end in the browser

- [ ] **Step 1: Start studio**

```bash
SKIP_SETUP=1 NODE_ENV=production pm2 restart abl-studio
# or in dev:
pnpm dev --filter=@abl/studio
```

- [ ] **Step 2: Open Arch overlay on any project**

Navigate to a project page. Click the Arch icon to open the overlay. Verify:

- `[ ]` "Show artifacts" button appears in header (even if no session has loaded yet)
- `[ ]` Footer uses the full card layout with paperclip icon and "Up to 10 files, 10MB each" hint

- [ ] **Step 3: Click "Show artifacts"**

Verify:

- `[ ]` Button label changes to "Hide artifacts"
- `[ ]` Button gets accent-tinted background
- `[ ]` Journal tab appears first in the tab strip
- `[ ]` Journal tab has a small pin icon before its label
- `[ ]` Journal tab has no close `×` button
- `[ ]` Artifact panel width is noticeably wider than before (85vw minus 540px chat)

- [ ] **Step 4: Resume gate test**

Find a project with an existing Arch session to trigger the resume gate. With the overlay in resume-gate mode, verify:

- `[ ]` "Show artifacts" / "Hide artifacts" button is still visible in the header

- [ ] **Step 5: Attachment test**

In the chat footer:

- `[ ]` Click the paperclip — file picker opens
- `[ ]` Select a supported file (e.g. a `.txt` or `.pdf`) — attachment chip appears inside the input card with "Uploading…" then "✓ ready" status
- `[ ]` Send a message — the attachment is sent alongside the text (verify in PM2 logs or via network tab that `blobId` is in the payload)
- `[ ]` After send, the attachment chip clears

---

## Commit log (expected after all tasks)

```
[ABLP-162] feat(arch-ai): add show/hide artifacts i18n keys
[ABLP-162] refactor(arch-ai): add ensureJournalFirst store helper
[ABLP-162] feat(arch-ai): pin journal tab, persistent artifact toggle, widen to 85vw
[ABLP-162] refactor(arch-ai): add useComposerAttachments hook for in-project attachment lifecycle
[ABLP-162] feat(arch-ai): bring in-project chat footer to onboarding parity
```

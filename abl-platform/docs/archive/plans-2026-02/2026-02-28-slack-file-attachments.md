# Slack File Attachments — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire Slack inbound file attachments into the existing attachment pipeline so files uploaded in Slack messages are downloaded, processed by the multimodal-service, and made available to the LLM as content blocks.

**Architecture:** When a Slack `message` event with `subtype: "file_share"` arrives, the adapter extracts file metadata (Slack file objects) into the normalized message. The inbound worker then downloads each file from Slack's CDN using the bot token, streams them to the multimodal-service via `MultimodalServiceClient.upload()`, collects the resulting `attachmentIds`, and passes them to `executeMessage()` via `ExecuteMessageOptions`. The existing `MessagePreprocessor` handles the rest (image → vision blocks, documents → text).

**Tech Stack:** TypeScript, Slack Events API, `MultimodalServiceClient` (internal HTTP), BullMQ inbound worker, Vitest

**Reference:** koreserver's `api/services/KAChannelServices/slack.js:1113-1208` (`resolveFileAttachments`) implements the same pattern — extracts `files[]` from Slack events, downloads from `url_private_download` with `Bearer` auth, uploads to internal service.

---

## Phase 1: Types & Interfaces

### Task 1: Add `SlackFile` interface and `files` to `SlackMessageEvent`

**Files:**

- Modify: `apps/runtime/src/channels/adapters/slack-adapter.ts:51-62`

**Context:** The `SlackMessageEvent` interface is missing the `files` array that Slack sends on `file_share` messages. Per official Slack docs, message events with file uploads have `subtype: "file_share"`, `upload: true`, and a `files` array of file objects. Each file object has `id`, `name`, `mimetype`, `filetype`, `size`, `url_private_download`, and `file_access` fields. See koreserver usage at `slack.js:1128` where it destructures `{ filetype, url_private_download: downloadUrl }`.

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/adapters/slack-file-attachments.test.ts
import { describe, it, expect } from 'vitest';
import { SlackAdapter } from '../../channels/adapters/slack-adapter.js';

const adapter = new SlackAdapter();

describe('Slack file attachment handling', () => {
  describe('shouldProcess', () => {
    it('accepts file_share messages with files but no text', () => {
      const body = {
        type: 'event_callback',
        team_id: 'T123',
        api_app_id: 'A123',
        event_id: 'Ev123',
        event_time: 1234567890,
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C123',
          user: 'U123',
          text: '',
          ts: '1234567890.123456',
          event_ts: '1234567890.123456',
          upload: true,
          files: [
            {
              id: 'F123',
              name: 'report.pdf',
              mimetype: 'application/pdf',
              filetype: 'pdf',
              size: 1024,
              url_private_download:
                'https://files.slack.com/files-pri/T123-F123/download/report.pdf',
              file_access: 'visible',
            },
          ],
        },
      };
      expect(adapter.shouldProcess(body)).toBe(true);
    });

    it('accepts file_share messages with both text and files', () => {
      const body = {
        type: 'event_callback',
        team_id: 'T123',
        api_app_id: 'A123',
        event_id: 'Ev456',
        event_time: 1234567890,
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C123',
          user: 'U123',
          text: 'Check this out',
          ts: '1234567890.123456',
          event_ts: '1234567890.123456',
          upload: true,
          files: [
            {
              id: 'F456',
              name: 'image.png',
              mimetype: 'image/png',
              filetype: 'png',
              size: 2048,
              url_private_download:
                'https://files.slack.com/files-pri/T123-F456/download/image.png',
              file_access: 'visible',
            },
          ],
        },
      };
      expect(adapter.shouldProcess(body)).toBe(true);
    });
  });

  describe('buildNormalizedMessage', () => {
    it('includes fileReferences in metadata for file_share events', () => {
      const body = {
        type: 'event_callback',
        team_id: 'T123',
        api_app_id: 'A123',
        event_id: 'Ev789',
        event_time: 1234567890,
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C123',
          user: 'U123',
          text: 'Here is the doc',
          ts: '1234567890.123456',
          event_ts: '1234567890.123456',
          upload: true,
          files: [
            {
              id: 'F789',
              name: 'report.pdf',
              mimetype: 'application/pdf',
              filetype: 'pdf',
              size: 5000,
              url_private_download:
                'https://files.slack.com/files-pri/T123-F789/download/report.pdf',
              file_access: 'visible',
            },
            {
              id: 'F790',
              name: 'photo.jpg',
              mimetype: 'image/jpeg',
              filetype: 'jpg',
              size: 3000,
              url_private_download:
                'https://files.slack.com/files-pri/T123-F790/download/photo.jpg',
              file_access: 'visible',
            },
          ],
        },
      };

      const msg = adapter.buildNormalizedMessage(body);
      expect(msg.text).toBe('Here is the doc');

      const fileRefs = msg.metadata?.slackFileReferences as any[];
      expect(fileRefs).toHaveLength(2);
      expect(fileRefs[0]).toEqual({
        slackFileId: 'F789',
        name: 'report.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 5000,
        downloadUrl: 'https://files.slack.com/files-pri/T123-F789/download/report.pdf',
      });
      expect(fileRefs[1]).toEqual({
        slackFileId: 'F790',
        name: 'photo.jpg',
        mimetype: 'image/jpeg',
        filetype: 'jpg',
        size: 3000,
        downloadUrl: 'https://files.slack.com/files-pri/T123-F790/download/photo.jpg',
      });
    });

    it('skips files with file_access !== visible', () => {
      const body = {
        type: 'event_callback',
        team_id: 'T123',
        api_app_id: 'A123',
        event_id: 'Ev800',
        event_time: 1234567890,
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C123',
          user: 'U123',
          text: 'External file',
          ts: '1234567890.123456',
          event_ts: '1234567890.123456',
          upload: true,
          files: [
            {
              id: 'F800',
              name: 'external.pdf',
              mimetype: 'application/pdf',
              filetype: 'pdf',
              size: 1000,
              url_private_download:
                'https://files.slack.com/files-pri/T123-F800/download/external.pdf',
              file_access: 'check_file_info',
            },
          ],
        },
      };

      const msg = adapter.buildNormalizedMessage(body);
      const fileRefs = msg.metadata?.slackFileReferences as any[];
      expect(fileRefs).toHaveLength(0);
    });

    it('has no fileReferences for regular text messages', () => {
      const body = {
        type: 'event_callback',
        team_id: 'T123',
        api_app_id: 'A123',
        event_id: 'Ev900',
        event_time: 1234567890,
        event: {
          type: 'message',
          channel: 'C123',
          user: 'U123',
          text: 'Just a text message',
          ts: '1234567890.123456',
          event_ts: '1234567890.123456',
        },
      };

      const msg = adapter.buildNormalizedMessage(body);
      const fileRefs = msg.metadata?.slackFileReferences as any[] | undefined;
      expect(fileRefs ?? []).toHaveLength(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/adapters/slack-file-attachments.test.ts`
Expected: FAIL — `shouldProcess` returns `false` for file-only messages; `metadata.slackFileReferences` is `undefined`.

**Step 3: Add `SlackFile` interface and update `SlackMessageEvent`**

In `apps/runtime/src/channels/adapters/slack-adapter.ts`, add the `SlackFile` interface before `SlackMessageEvent` and update the event interface:

```typescript
// Add BEFORE SlackMessageEvent (around line 51)

/** Slack file object — subset of fields relevant for attachment processing. */
interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private_download: string;
  /** 'visible' = downloadable, 'check_file_info' = Slack Connect, may need extra steps */
  file_access: string;
}

interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  event_ts: string;
  channel_type?: string;
  bot_id?: string;
  /** Present on file_share messages */
  files?: SlackFile[];
  /** True when the user uploaded the file (vs. shared from another channel) */
  upload?: boolean;
}
```

**Step 4: Update `shouldProcess` to accept file_share messages**

In `apps/runtime/src/channels/adapters/slack-adapter.ts`, replace the text check at line 248:

```typescript
// Must have text content OR file attachments
const hasText = event.text && event.text.trim().length > 0;
const hasFiles = Array.isArray(event.files) && event.files.length > 0;
if (!hasText && !hasFiles) return false;

return true;
```

**Step 5: Update `buildNormalizedMessage` to extract file references**

In the standard message event block of `buildNormalizedMessage` (around line 347-362), add file reference extraction before the return statement:

```typescript
// Extract file references for downloadable files
const slackFileReferences = (event.files ?? [])
  .filter((f) => f.file_access === 'visible' && f.url_private_download)
  .map((f) => ({
    slackFileId: f.id,
    name: f.name,
    mimetype: f.mimetype,
    filetype: f.filetype,
    size: f.size,
    downloadUrl: f.url_private_download,
  }));

return {
  externalMessageId: event.event_ts || event.ts,
  externalSessionKey: sessionParts.join(':'),
  text,
  metadata: {
    slackTeamId: evtPayload.team_id,
    slackChannelId: event.channel,
    slackUserId: event.user,
    slackTs: event.ts,
    slackThreadTs: event.thread_ts,
    slackChannelType: event.channel_type,
    slackEventType: event.type,
    slackFileReferences,
  },
  timestamp: new Date(parseFloat(event.event_ts || event.ts) * 1000),
};
```

**Step 6: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/adapters/slack-file-attachments.test.ts`
Expected: PASS

**Step 7: Run existing Slack tests to verify no regressions**

Run: `cd apps/runtime && npx vitest run src/__tests__/adapters/slack-stream-buffer.test.ts src/__tests__/adapters/slack-stream-client.test.ts src/__tests__/adapters/slack-transform.test.ts src/__tests__/webhooks/slack-events.test.ts`
Expected: PASS (all existing tests still pass)

**Step 8: Commit**

```bash
git add apps/runtime/src/channels/adapters/slack-adapter.ts apps/runtime/src/__tests__/adapters/slack-file-attachments.test.ts
git commit -m "feat(slack): add SlackFile interface, accept file_share events, extract file references"
```

---

## Phase 2: Slack File Downloader

### Task 2: Create `SlackFileDownloader` utility

**Files:**

- Create: `apps/runtime/src/channels/adapters/slack-file-downloader.ts`
- Create: `apps/runtime/src/__tests__/adapters/slack-file-downloader.test.ts`

**Context:** Slack files require authenticated download — `GET url_private_download` with `Authorization: Bearer <bot_token>`. koreserver does this in `utils/request.js:149-247` (`downloadAndSaveAttachments`). Our version should return a `Readable` stream (since `MultimodalServiceClient.upload()` accepts a `stream: Readable` param — see `multimodal-service-client.ts:28`). We also need to handle: files that are too large (configurable limit), download timeouts, and HTTP errors.

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/adapters/slack-file-downloader.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

// We'll mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  downloadSlackFile,
  type SlackFileReference,
  type SlackFileDownloadResult,
} from '../../channels/adapters/slack-file-downloader.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const FILE_REF: SlackFileReference = {
  slackFileId: 'F123',
  name: 'report.pdf',
  mimetype: 'application/pdf',
  filetype: 'pdf',
  size: 1024,
  downloadUrl: 'https://files.slack.com/files-pri/T123-F123/download/report.pdf',
};

describe('downloadSlackFile', () => {
  it('downloads a file and returns a readable stream', async () => {
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: bodyStream,
    });

    const result = await downloadSlackFile(FILE_REF, 'xoxb-test-token');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.filename).toBe('report.pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.sizeBytes).toBe(1024);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      FILE_REF.downloadUrl,
      expect.objectContaining({
        headers: { Authorization: 'Bearer xoxb-test-token' },
      }),
    );
  });

  it('returns error on HTTP failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    const result = await downloadSlackFile(FILE_REF, 'xoxb-test-token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('403');
    }
  });

  it('returns error when file exceeds max size', async () => {
    const bigFile: SlackFileReference = { ...FILE_REF, size: 200_000_000 };
    const result = await downloadSlackFile(bigFile, 'xoxb-test-token', {
      maxSizeBytes: 100_000_000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exceeds');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await downloadSlackFile(FILE_REF, 'xoxb-test-token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Network error');
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/adapters/slack-file-downloader.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement `slack-file-downloader.ts`**

```typescript
// apps/runtime/src/channels/adapters/slack-file-downloader.ts
/**
 * Slack File Downloader
 *
 * Downloads files from Slack's CDN using the bot token for authentication.
 * Returns a Node.js Readable stream suitable for piping to MultimodalServiceClient.upload().
 *
 * Slack requires: GET url_private_download with Authorization: Bearer <bot_token>
 * See: https://docs.slack.dev/reference/file-object
 */

import { Readable } from 'stream';

const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export interface SlackFileReference {
  slackFileId: string;
  name: string;
  mimetype: string;
  filetype: string;
  size: number;
  downloadUrl: string;
}

export type SlackFileDownloadResult =
  | { success: true; stream: Readable; filename: string; mimeType: string; sizeBytes: number }
  | { success: false; error: string; slackFileId: string };

export interface DownloadOptions {
  maxSizeBytes?: number;
  timeoutMs?: number;
}

export async function downloadSlackFile(
  fileRef: SlackFileReference,
  botToken: string,
  options?: DownloadOptions,
): Promise<SlackFileDownloadResult> {
  const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;

  // Pre-check size before downloading
  if (fileRef.size > maxSize) {
    return {
      success: false,
      error: `File "${fileRef.name}" (${fileRef.size} bytes) exceeds max size (${maxSize} bytes)`,
      slackFileId: fileRef.slackFileId,
    };
  }

  try {
    const response = await fetch(fileRef.downloadUrl, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Slack file download failed: HTTP ${response.status} ${response.statusText}`,
        slackFileId: fileRef.slackFileId,
      };
    }

    // Convert web ReadableStream to Node.js Readable
    const webStream = response.body;
    if (!webStream) {
      return {
        success: false,
        error: 'Slack file download returned no body',
        slackFileId: fileRef.slackFileId,
      };
    }

    const nodeStream = Readable.fromWeb(webStream as any);

    return {
      success: true,
      stream: nodeStream,
      filename: fileRef.name,
      mimeType: fileRef.mimetype,
      sizeBytes: fileRef.size,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown download error',
      slackFileId: fileRef.slackFileId,
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/adapters/slack-file-downloader.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/channels/adapters/slack-file-downloader.ts apps/runtime/src/__tests__/adapters/slack-file-downloader.test.ts
git commit -m "feat(slack): add SlackFileDownloader for authenticated Slack CDN downloads"
```

---

## Phase 3: Inbound Worker File Processing

### Task 3: Wire file download + upload into the inbound worker

**Files:**

- Modify: `apps/runtime/src/services/queues/inbound-worker.ts:213-227`
- Create: `apps/runtime/src/__tests__/inbound-worker-attachments.test.ts`

**Context:** The inbound worker at line 214 calls `executor.executeMessage(session.runtimeSessionId, payload.message.text, onChunk)` — it never passes `ExecuteMessageOptions` with `attachmentIds`. The executor's signature (see `types.ts:221-223`) supports `{ attachmentIds?: string[] }`. The flow is: check for `slackFileReferences` in `payload.message.metadata` → download each file via `downloadSlackFile()` → upload each stream to `MultimodalServiceClient.upload()` → collect `attachmentIds` → pass to `executeMessage()`. File processing must be non-blocking for the text — if all file downloads fail, the text message should still be processed.

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/inbound-worker-attachments.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';

// Test the file processing logic as an extracted function (we'll extract it in Step 3)
import {
  processSlackFileReferences,
  type SlackFileReferenceMetadata,
} from '../../channels/adapters/slack-file-processor.js';

describe('processSlackFileReferences', () => {
  it('downloads and uploads files, returning attachmentIds', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('file-content')),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });

    const mockUpload = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-123',
      status: 'pending',
    });

    const fileRefs: SlackFileReferenceMetadata[] = [
      {
        slackFileId: 'F123',
        name: 'report.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 1024,
        downloadUrl: 'https://files.slack.com/files-pri/T123-F123/download/report.pdf',
      },
    ];

    const result = await processSlackFileReferences(fileRefs, {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-123']);
    expect(mockDownload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledOnce();
  });

  it('skips failed downloads gracefully', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: false,
      error: 'HTTP 403',
      slackFileId: 'F123',
    });
    const mockUpload = vi.fn();

    const fileRefs: SlackFileReferenceMetadata[] = [
      {
        slackFileId: 'F123',
        name: 'secret.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 1024,
        downloadUrl: 'https://files.slack.com/download/secret.pdf',
      },
    ];

    const result = await processSlackFileReferences(fileRefs, {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual([]);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('skips failed uploads gracefully', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('file-content')),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });
    const mockUpload = vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'UPLOAD_FAILED', message: 'Service unavailable' },
    });

    const fileRefs: SlackFileReferenceMetadata[] = [
      {
        slackFileId: 'F123',
        name: 'report.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 1024,
        downloadUrl: 'https://files.slack.com/download/report.pdf',
      },
    ];

    const result = await processSlackFileReferences(fileRefs, {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual([]);
  });

  it('processes multiple files concurrently, collecting all successful IDs', async () => {
    const mockDownload = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stream: Readable.from(Buffer.from('file1')),
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'HTTP 404',
        slackFileId: 'F2',
      })
      .mockResolvedValueOnce({
        success: true,
        stream: Readable.from(Buffer.from('file3')),
        filename: 'c.png',
        mimeType: 'image/png',
        sizeBytes: 200,
      });

    const mockUpload = vi
      .fn()
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-1', status: 'pending' })
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-3', status: 'pending' });

    const fileRefs: SlackFileReferenceMetadata[] = [
      {
        slackFileId: 'F1',
        name: 'a.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 100,
        downloadUrl: 'https://url/a',
      },
      {
        slackFileId: 'F2',
        name: 'b.doc',
        mimetype: 'application/msword',
        filetype: 'doc',
        size: 300,
        downloadUrl: 'https://url/b',
      },
      {
        slackFileId: 'F3',
        name: 'c.png',
        mimetype: 'image/png',
        filetype: 'png',
        size: 200,
        downloadUrl: 'https://url/c',
      },
    ];

    const result = await processSlackFileReferences(fileRefs, {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-1', 'att-3']);
  });

  it('returns empty array when no file references provided', async () => {
    const result = await processSlackFileReferences([], {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      downloadFn: vi.fn(),
      uploadFn: vi.fn(),
    });

    expect(result).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/inbound-worker-attachments.test.ts`
Expected: FAIL — module not found.

**Step 3: Create `slack-file-processor.ts`**

Extract the file processing logic into a testable module (separate from the worker for testability and reusability across channels).

```typescript
// apps/runtime/src/channels/adapters/slack-file-processor.ts
/**
 * Slack File Processor
 *
 * Orchestrates the download-then-upload flow for Slack file attachments.
 * Extracted from the inbound worker for testability and potential reuse
 * by other channels that need authenticated file downloads.
 *
 * Each file is processed independently — individual failures don't block others.
 */

import type { Readable } from 'stream';
import type { SlackFileReference, SlackFileDownloadResult } from './slack-file-downloader.js';
import type { UploadResult } from '../../attachments/multimodal-service-client.js';

const LOG_PREFIX = '[SlackFileProcessor]';

export type SlackFileReferenceMetadata = SlackFileReference;

export interface ProcessOptions {
  botToken: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  channel: string;
  /** Injectable for testing — defaults to downloadSlackFile */
  downloadFn?: (ref: SlackFileReference, token: string) => Promise<SlackFileDownloadResult>;
  /** Injectable for testing — defaults to MultimodalServiceClient.upload() */
  uploadFn?: (params: {
    stream: Readable;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    tenantId: string;
    projectId: string;
    sessionId: string;
    channel: string;
  }) => Promise<UploadResult>;
}

/**
 * Process Slack file references: download from Slack CDN, upload to multimodal-service.
 * Returns an array of attachment IDs for successfully processed files.
 * Never throws — individual file failures are logged and skipped.
 */
export async function processSlackFileReferences(
  fileRefs: SlackFileReferenceMetadata[],
  options: ProcessOptions,
): Promise<string[]> {
  if (fileRefs.length === 0) return [];

  const { botToken, tenantId, projectId, sessionId, channel, downloadFn, uploadFn } = options;

  const results = await Promise.all(
    fileRefs.map(async (ref) => {
      try {
        // 1. Download from Slack
        const download = await downloadFn!(ref, botToken);
        if (!download.success) {
          console.warn(LOG_PREFIX, `Download failed for ${ref.name}:`, download.error);
          return null;
        }

        // 2. Upload to multimodal-service
        const upload = await uploadFn!({
          stream: download.stream,
          filename: download.filename,
          mimeType: download.mimeType,
          sizeBytes: download.sizeBytes,
          tenantId,
          projectId,
          sessionId,
          channel,
        });

        if (!upload.success) {
          console.warn(LOG_PREFIX, `Upload failed for ${ref.name}:`, upload.error);
          return null;
        }

        return upload.attachmentId;
      } catch (err) {
        console.error(LOG_PREFIX, `Error processing ${ref.name}:`, err);
        return null;
      }
    }),
  );

  return results.filter((id): id is string => id !== null);
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/inbound-worker-attachments.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/channels/adapters/slack-file-processor.ts apps/runtime/src/__tests__/inbound-worker-attachments.test.ts
git commit -m "feat(slack): add SlackFileProcessor to orchestrate download-then-upload flow"
```

---

### Task 4: Wire `processSlackFileReferences` into the inbound worker

**Files:**

- Modify: `apps/runtime/src/services/queues/inbound-worker.ts:205-227`

**Context:** The inbound worker at line 214 calls `executor.executeMessage(session.runtimeSessionId, payload.message.text, onChunk)` without passing `ExecuteMessageOptions`. We need to: (1) check if the message has `slackFileReferences` in metadata, (2) if so, run `processSlackFileReferences` with real download/upload deps, (3) pass the resulting `attachmentIds` to `executeMessage`. File processing should not block the message if it fails entirely. The `resolvedConnection.credentials.bot_token` is already available at line 178.

**Step 1: Add file processing block before `executeMessage` call**

In `apps/runtime/src/services/queues/inbound-worker.ts`, insert the file processing logic between the streaming setup (line 203) and the `executePromise` assignment (line 205):

```typescript
// ── Process Slack file attachments (if present) ─────────────────
let attachmentIds: string[] | undefined;
const slackFileRefs = payload.message.metadata?.slackFileReferences as
  | import('../../channels/adapters/slack-file-processor.js').SlackFileReferenceMetadata[]
  | undefined;

if (payload.channelType === 'slack' && slackFileRefs && slackFileRefs.length > 0) {
  const botToken = resolvedConnection.credentials?.bot_token as string;
  if (botToken) {
    try {
      const { processSlackFileReferences } =
        await import('../../channels/adapters/slack-file-processor.js');
      const { downloadSlackFile } =
        await import('../../channels/adapters/slack-file-downloader.js');
      const { MultimodalServiceClient } =
        await import('../../attachments/multimodal-service-client.js');
      const mmClient = new MultimodalServiceClient();

      attachmentIds = await processSlackFileReferences(slackFileRefs, {
        botToken,
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        sessionId: session.runtimeSessionId,
        channel: 'slack',
        downloadFn: downloadSlackFile,
        uploadFn: (params) => mmClient.upload(params),
      });

      if (attachmentIds.length > 0) {
        log.info('Slack file attachments processed', {
          tenantId: payload.tenantId,
          sessionId: session.runtimeSessionId,
          attachmentIds,
          count: attachmentIds.length,
        });
      }
    } catch (err) {
      log.error('Slack file attachment processing failed (non-blocking)', {
        tenantId: payload.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue without attachments — don't block the text message
    }
  } else {
    log.warn('Slack file attachments present but no bot_token available', {
      tenantId: payload.tenantId,
      connectionId: payload.connectionId,
    });
  }
}
```

**Step 2: Pass `attachmentIds` to `executeMessage`**

Replace the existing `executeMessage` call (around line 214) to include options:

```typescript
// BEFORE (line 214):
// executePromise = executor.executeMessage(
//   session.runtimeSessionId,
//   payload.message.text,
//   (chunk: string) => { ... },
// );

// AFTER:
executePromise = executor.executeMessage(
  session.runtimeSessionId,
  payload.message.text,
  (chunk: string) => {
    chunks.push(chunk);
    if (streamBuffer) {
      streamBuffer.onChunk(chunk).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('Slack stream onChunk error', { error: errMsg });
      });
    }
  },
  attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : undefined,
);
```

**Step 3: Run existing inbound worker test**

Run: `cd apps/runtime && npx vitest run src/__tests__/inbound-worker.test.ts`
Expected: PASS (existing test doesn't have file refs in metadata, so the new code path is skipped)

**Step 4: Run the full Slack test suite**

Run: `cd apps/runtime && npx vitest run src/__tests__/adapters/slack-file-attachments.test.ts src/__tests__/adapters/slack-file-downloader.test.ts src/__tests__/inbound-worker-attachments.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/queues/inbound-worker.ts
git commit -m "feat(slack): wire file download+upload into inbound worker with attachmentIds"
```

---

## Phase 4: Typecheck & Integration Verification

### Task 5: Typecheck and verify full test suite

**Files:**

- No new files — verification only

**Step 1: Run typecheck**

Run: `cd apps/runtime && npx tsc --noEmit`
Expected: PASS (no type errors)

**Step 2: Run all runtime tests**

Run: `cd apps/runtime && npx vitest run`
Expected: PASS

**Step 3: Run all Slack-specific tests together**

Run: `cd apps/runtime && npx vitest run src/__tests__/adapters/slack-file-attachments.test.ts src/__tests__/adapters/slack-file-downloader.test.ts src/__tests__/inbound-worker-attachments.test.ts src/__tests__/adapters/slack-stream-buffer.test.ts src/__tests__/adapters/slack-stream-client.test.ts src/__tests__/adapters/slack-transform.test.ts src/__tests__/webhooks/slack-events.test.ts`
Expected: PASS

**Step 4: Commit if any fixups were needed**

```bash
git add -A
git commit -m "fix(slack): typecheck and test fixups for file attachment wiring"
```

---

## Summary of Changes

| File                                 | Change                                                                                                                                                                             | Purpose                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `slack-adapter.ts`                   | Add `SlackFile` interface, `files`/`upload` to `SlackMessageEvent`, update `shouldProcess` to accept file-only messages, extract `slackFileReferences` in `buildNormalizedMessage` | Accept and normalize Slack file events                         |
| `slack-file-downloader.ts`           | **NEW** — `downloadSlackFile()` function                                                                                                                                           | Download files from Slack CDN with Bearer auth                 |
| `slack-file-processor.ts`            | **NEW** — `processSlackFileReferences()` function                                                                                                                                  | Orchestrate download→upload flow with graceful error handling  |
| `inbound-worker.ts`                  | Add file processing block before `executeMessage`, pass `attachmentIds` in options                                                                                                 | Connect Slack files to the attachment pipeline                 |
| `slack-file-attachments.test.ts`     | **NEW** — tests for adapter changes                                                                                                                                                | Verify `shouldProcess` and `buildNormalizedMessage` with files |
| `slack-file-downloader.test.ts`      | **NEW** — tests for downloader                                                                                                                                                     | Verify download auth, error handling, size limits              |
| `inbound-worker-attachments.test.ts` | **NEW** — tests for processor                                                                                                                                                      | Verify download→upload orchestration, partial failures         |

### What We're NOT Changing (already works downstream)

- `MultimodalServiceClient` — already accepts streams and returns `attachmentId`
- `MessagePreprocessor` — already transforms `attachmentIds` → `ContentBlock[]`
- `RuntimeExecutor.executeMessage()` — already accepts `ExecuteMessageOptions.attachmentIds`
- `NormalizedIncomingMessage` — using `metadata` bag (no interface change needed)
- `InboundJobPayload` — carries metadata through the existing `message` field
- `channel-webhooks.ts` — thin enqueue layer, no changes needed

### Scopes Not Covered (future work)

- **Outbound file sending** — sending files from ABL back to Slack (requires `files.getUploadURLExternal` + `files.completeUploadExternal`)
- **Other channels** — WhatsApp, email adapters have similar gaps
- **`supportsMedia` flag** — currently `true`, which is now accurate for inbound; outbound remains unimplemented

# Multimodal Vision Enhancement — Low-Level Design

## Task T-1: Store Video Key Frames in S3

### Files to Modify

- `packages/database/src/models/attachment.model.ts` — Add `frameStorageKeys: string[]` to `IAttachment` interface and schema
- `apps/multimodal-service/src/jobs/process-job.ts` — Upload extracted frames to storage via existing `StorageProvider`, save keys on Attachment doc

### Files to Create

None — all changes are in existing files.

### Interface Changes

```typescript
// packages/database/src/models/attachment.model.ts
// Add to IAttachment interface (after line 60, thumbnailStorageKey)
export interface IAttachment {
  // ... existing fields ...

  // Video frame storage (NEW)
  frameStorageKeys: string[]; // e.g. ["{base}/frame-0", "{base}/frame-1", ...]
}
```

### Function Signatures

```typescript
// apps/multimodal-service/src/jobs/process-job.ts
// Reuse existing deriveStorageKey(baseKey, segment) at line 661:
//   deriveStorageKey("tenant/proj/sess/att-id/original", "frame-2")
//   → "tenant/proj/sess/att-id/frame-2"

// Modified: processVideo() — after extractKeyFrames, upload each frame buffer
async function processVideo(ctx: VideoProcessContext, deps: VideoProcessDeps): Promise<void>;
// NEW behavior: uploads framesResult.frames[] to storage, saves keys in $set
```

### Database/Model Changes

- `IAttachment.frameStorageKeys`: `string[]`, default `[]`
- Schema: `frameStorageKeys: { type: [String], default: [] }`
- No new index needed — frames are looked up via the parent attachment's `_id`
- Delete cleanup: `deleteAttachment()` in `multimodal-service.ts` must include `frameStorageKeys` in parallel storage cleanup

### Subtasks (execution order)

1. **ST-1.1**: Add `frameStorageKeys: string[]` to `IAttachment` interface in `packages/database/src/models/attachment.model.ts` (line ~60, after `thumbnailStorageKey`). Add corresponding schema field (line ~155, after `thumbnailStorageKey` schema field). Default `[]`.

2. **ST-1.2**: In `apps/multimodal-service/src/jobs/process-job.ts`, add constant `STORAGE_KEY_SEGMENT_FRAME_PREFIX = 'frame-'` alongside existing segment constants (line ~44). Reuse existing `deriveStorageKey(baseKey, segment)` helper (line 661) which replaces the last path segment: call `deriveStorageKey(storageKey, 'frame-' + i)`.

   **PREREQUISITE VERIFIED**: `ExtractKeyFramesResult.frames: Buffer[]` field exists at `video-processor-ffmpeg.ts:100`. The current `processVideo()` only reads `.totalFramesExtracted` and `.timestamps` but the frame buffers ARE returned — just unused.

3. **ST-1.3**: In `processVideo()` (line 547-550), after `framesResult.success` check, upload each frame buffer to storage in parallel:

   ```typescript
   const frameStorageKeys: string[] = [];
   if (framesResult.success && framesResult.frames.length > 0) {
     const uploadResults = await Promise.allSettled(
       framesResult.frames.map(async (frameBuffer, i) => {
         const frameKey = deriveStorageKey(storageKey, `frame-${i}`);
         await storageProvider.upload({
           key: frameKey,
           body: Readable.from(frameBuffer),
           contentType: 'image/png',
           sizeBytes: frameBuffer.length,
           metadata: { attachmentId, tenantId, frameIndex: String(i) },
         });
         return frameKey;
       }),
     );
     for (const result of uploadResults) {
       if (result.status === 'fulfilled') {
         frameStorageKeys.push(result.value);
       }
     }
   }
   ```

   Add `frameStorageKeys` to the `$set` in the `Attachment.findOneAndUpdate` call (line 596-608).
   Add `workerLog` for frame upload results:

   ```typescript
   workerLog(WORKER_NAME, 'Video frames uploaded to storage', {
     attachmentId,
     totalFrames: framesResult.frames.length,
     uploadedFrames: frameStorageKeys.length,
     failedFrames: framesResult.frames.length - frameStorageKeys.length,
   });
   ```

4. **ST-1.4**: In `apps/multimodal-service/src/services/multimodal-service.ts` `deleteAttachment()` (line 398-434), add `frameStorageKeys` to the storage cleanup:
   ```typescript
   // After line 411 (thumbnailStorageKey)
   if (attachment.frameStorageKeys?.length) {
     storageKeys.push(...attachment.frameStorageKeys);
   }
   ```

### Acceptance Criteria

- AC-1.1: Given a video upload that extracts 5 key frames, When processing completes, Then the Attachment document has `frameStorageKeys` with 5 storage key strings matching pattern `{base}/frame-{0-4}`
  - Verify: Check MongoDB attachment document after video processing
  - Expected: `frameStorageKeys: ["tenant/.../frame-0", ..., "tenant/.../frame-4"]`

- AC-1.2: Given a video where frame extraction partially fails (e.g., 3/5 succeed), When processing completes, Then only successful frame keys are stored, `frameStorageKeys.length === 3`
  - Verify: `Promise.allSettled` handles individual frame upload failures

- AC-1.3: Given an attachment with frameStorageKeys, When `deleteAttachment()` is called, Then all frame objects are cleaned from storage alongside original/resized/thumbnail
  - Verify: Storage delete calls include frame keys

- AC-1.4: `deleteBySession()` automatically handles frame cleanup because it iterates all attachments and calls `deleteAttachment()` per attachment, which now includes frame keys. No separate change needed — verify this path works.
  - Verify: `deleteBySession()` calls `deleteAttachment()` which includes frameStorageKeys cleanup

---

## Task T-2: Serve Video Frames via Internal API

### Files to Modify

- `apps/multimodal-service/src/routes/attachments.ts` — Add `GET /internal/attachments/:attachmentId/frames/:frameIndex` route
- `apps/multimodal-service/src/services/multimodal-service.ts` — Add `downloadFrameContent(attachmentId, tenantId, frameIndex)` method
- `apps/runtime/src/attachments/multimodal-service-client.ts` — Add `downloadFrameContent(id, tenantId, frameIndex)` client method

### Files to Create

None.

### Function Signatures

```typescript
// apps/multimodal-service/src/services/multimodal-service.ts
async downloadFrameContent(
  attachmentId: string,
  tenantId: string,
  frameIndex: number,
): Promise<{ body: Readable; contentType: string; sizeBytes: number; attachment: IAttachment } | null>

// apps/runtime/src/attachments/multimodal-service-client.ts
async downloadFrameContent(
  id: string,
  tenantId: string,
  frameIndex: number,
): Promise<AttachmentContentResult | null>
```

### Subtasks (execution order)

1. **ST-2.1**: In `apps/multimodal-service/src/services/multimodal-service.ts`, add `downloadFrameContent()` method:
   - Fetch attachment by `{_id: attachmentId, tenantId}`
   - Validate `attachment.category === 'video'`
   - Validate `frameIndex >= 0 && frameIndex < attachment.frameStorageKeys.length`
   - Download from storage using `attachment.frameStorageKeys[frameIndex]`
   - Return `{ body, contentType: 'image/png', sizeBytes, attachment }` or `null`

2. **ST-2.2**: In `apps/multimodal-service/src/routes/attachments.ts`, add route **BEFORE** the `/:attachmentId` catch-all (Express route ordering!):

   ```typescript
   // MUST be registered before /:attachmentId to avoid path capture
   router.get('/:attachmentId/frames/:frameIndex', async (req, res) => {
     const { tenantId } = req as InternalRequest; // extracted by requireInternalAuth middleware
     const { attachmentId, frameIndex: frameIndexStr } = req.params;

     // Validate frameIndex is a non-negative integer (Zod)
     const parsed = z
       .object({
         frameIndex: z
           .string()
           .regex(/^\d+$/)
           .transform(Number)
           .pipe(z.number().int().min(0).max(9)),
       })
       .safeParse({ frameIndex: frameIndexStr });

     if (!parsed.success) {
       res.status(400).json({
         success: false,
         error: { code: 'INVALID_FRAME_INDEX', message: 'frameIndex must be 0-9' },
       });
       return;
     }

     const download = await attachmentService.downloadFrameContent(
       attachmentId!,
       tenantId,
       parsed.data.frameIndex,
     );

     if (!download) {
       res.status(404).json({
         success: false,
         error: { code: 'NOT_FOUND', message: 'Frame not found' },
       });
       return;
     }

     res.setHeader('Content-Type', download.contentType);
     res.setHeader('Content-Length', String(download.sizeBytes));
     res.setHeader('Cache-Control', 'private, max-age=3600');
     await pipeline(download.body, res);
   });
   ```

   - Uses existing `requireInternalAuth` middleware (already applied to all routes in this router)
   - Zod validation for `frameIndex` (integer 0-9, matching max 10 frames)
   - Structured error envelope on 400/404 responses
   - Stream response with `Content-Type: image/png`, `Cache-Control: private, max-age=3600`

3. **ST-2.3**: In `apps/runtime/src/attachments/multimodal-service-client.ts`, add `downloadFrameContent()` method:

   ```typescript
   async downloadFrameContent(
     id: string,
     tenantId: string,
     frameIndex: number,
   ): Promise<AttachmentContentResult | null> {
     // Add constant at top of file: const FRAME_DOWNLOAD_TIMEOUT_MS = 5_000;
     // GET {baseUrl}/internal/attachments/{id}/frames/{frameIndex}
     // Per-frame timeout: FRAME_DOWNLOAD_TIMEOUT_MS = 5_000 (5 seconds)
     // Uses AbortSignal.timeout(FRAME_DOWNLOAD_TIMEOUT_MS)
     // Same error handling pattern as downloadAttachmentContent
   }
   ```

4. **ST-2.4**: In `apps/multimodal-service/src/routes/attachments.ts`, modify the existing `GET /:attachmentId/content` route (line 464) to accept a `?variant=resized` query parameter (backward-compatible — no variant param = original behavior):
   ```typescript
   // After fetching attachment via attachmentService.downloadAttachmentContent():
   // Add variant support to the service method signature:
   const variant = (req.query.variant as string) || undefined;
   const download = await attachmentService.downloadAttachmentContent(attachmentId!, tenantId, {
     variant,
   });
   ```
   Also update `downloadAttachmentContent` in `multimodal-service.ts` to accept optional `{ variant?: 'resized' }` options and resolve the appropriate storage key:
   ```typescript
   const effectiveKey =
     opts?.variant === 'resized' && attachment.resizedStorageKey
       ? attachment.resizedStorageKey
       : attachment.storageKey;
   ```

### Acceptance Criteria

- AC-2.1: Given a video attachment with 5 stored frames, When `GET /internal/attachments/:id/frames/2` is called, Then returns the PNG binary of frame-2 with `Content-Type: image/png`
  - Verify: HTTP request to the endpoint returns 200 with correct content type

- AC-2.2: Given a video attachment with 5 frames, When `GET /internal/attachments/:id/frames/7` is called (out of range), Then returns 404
  - Verify: Response status is 404

- AC-2.3: Given an image attachment (not video), When frame endpoint is called, Then returns 404
  - Verify: Only video category attachments serve frames

---

## Task T-3: Inject Video Frames as Vision Blocks in Runtime

### Files to Modify

- `apps/runtime/src/attachments/message-preprocessor.ts` — Enhance video case to download frames in parallel, create `ImageContent[]` blocks; thread `supportsVision`/`maxVideoFrames` through `transformAttachment`
- `apps/runtime/src/services/runtime-executor.ts` — Pass `supportsVision`/`maxVideoFrames` to preprocessor; emit trace event for status feedback

### Files to Create

None.

### Function Signatures

```typescript
// apps/runtime/src/attachments/message-preprocessor.ts

// New: download video frames in parallel, convert to ImageContent[]
private async resolveVideoFrames(
  attachment: IAttachment,
  tenantId: string,
  maxFrames: number,
): Promise<ImageContent[]>
// Returns up to maxFrames ImageContent blocks (partial success OK)

// Modified: transformAttachment — video case now calls resolveVideoFrames
// when vision model is available

// New parameter on PreprocessParams:
export interface PreprocessParams {
  // ... existing ...
  /** Whether the resolved model supports vision. Defaults to false. */
  supportsVision?: boolean;
  /** Max video frames to send as vision blocks. Defaults to 5. */
  maxVideoFrames?: number;
}
```

### Subtasks (execution order)

1. **ST-3.1**: `supportsVision` and `maxVideoFrames` are already on `PreprocessParams` (added by T-4 ST-4.1 in Wave 1). In `preprocess()`, extract them and pass to `transformAttachment`:

   ```typescript
   // In preprocess(), extract from params:
   const { supportsVision = false, maxVideoFrames = 5 } = params;
   // Pass to transformAttachment:
   await this.transformAttachment(
     attachment,
     tenantId,
     contentBlocks,
     prependedParts,
     effectivePolicy,
     supportsVision,
     maxVideoFrames,
   );
   ```

   Update `transformAttachment` signature to accept `supportsVision: boolean` and `maxVideoFrames: number` as the 6th and 7th parameters.

2. **ST-3.2**: Add `resolveVideoFrames()` private method to `MessagePreprocessor`:

   ```typescript
   private async resolveVideoFrames(
     attachment: IAttachment,
     tenantId: string,
     maxFrames: number,
   ): Promise<ImageContent[]> {
     const frameKeys = attachment.frameStorageKeys ?? [];
     if (frameKeys.length === 0) return [];

     const framesToFetch = Math.min(frameKeys.length, maxFrames);
     const results = await Promise.allSettled(
       Array.from({ length: framesToFetch }, (_, i) =>
         this.client.downloadFrameContent(attachment._id, tenantId, i)
       )
     );

     const imageBlocks: ImageContent[] = [];
     for (let i = 0; i < results.length; i++) {
       const result = results[i];
       if (result.status === 'fulfilled' && result.value) {
         imageBlocks.push({
           type: 'image',
           source: {
             type: 'base64',
             media_type: 'image/png',
             data: result.value.content.toString('base64'),
           },
           attachmentId: attachment._id,
         });
       } else {
         // Log individual frame download failures for traceability
         log.warn('Video frame download failed', {
           attachmentId: attachment._id,
           frameIndex: i,
           reason: result.status === 'rejected' ? (result.reason instanceof Error ? result.reason.message : String(result.reason)) : 'null response',
         });
       }
     }

     return imageBlocks;
   }
   ```

3. **ST-3.3**: Modify the `case 'video'` branch (line 220-225) in `transformAttachment`:

   ```typescript
   case 'video': {
     // Always include transcript text
     const content = applyPIIPolicy(attachment, piiPolicy, safeName);
     if (content) {
       prependedParts.push(`[Attached video: ${safeName}]\n${content}`);
     }

     // NEW: If model supports vision and frames exist, inject as ImageContent[]
     if (supportsVision && (attachment.frameStorageKeys?.length ?? 0) > 0) {
       const frameBlocks = await this.resolveVideoFrames(
         attachment,
         tenantId,
         maxVideoFrames,
       );
       contentBlocks.push(...frameBlocks);
       if (frameBlocks.length > 0) {
         log.info('Video frames injected as vision blocks', {
           attachmentId: attachment._id,
           frameCount: frameBlocks.length,
         });
       }
     }
     break;
   }
   ```

4. **ST-3.4**: Thread `supportsVision` and `maxVideoFrames` through the call chain:
   - In `runtime-executor.ts` preprocessing block (~line 3166): resolve model capabilities via `ModelCapabilities.supportsVision` and pass to `preprocessor.preprocess({ ..., supportsVision, maxVideoFrames })`.
   - Import `getModelCapabilities` from `@abl/compiler/platform/llm/model-capabilities.js`.

5. **ST-3.5**: In `runtime-executor.ts` (~line 3160), emit a trace event before calling `preprocessor.preprocess()` to surface status to the user:

   ```typescript
   // Before preprocessing — uses existing onTraceEvent pattern (line 3067 style)
   if (attachmentIds?.length) {
     options?.onTraceEvent?.({
       type: 'attachment_preprocess_start',
       data: { attachmentCount: attachmentIds.length },
       timestamp: new Date().toISOString(),
     });
   }
   ```

   The SDK's `FillerMessageService` already listens for trace events and can surface preprocessing status. After preprocessing completes, emit `attachment_preprocess` (already done at line 3182-3192).

   **Note**: HLD's `session.emit?.('statusUpdate', ...)` pattern does not exist in the codebase. The correct pattern is `options?.onTraceEvent?.(...)` as used throughout `runtime-executor.ts`.

### Acceptance Criteria

- AC-3.1: Given a video with 5 stored frames and a vision model (claude-3.5-sonnet), When user sends a message referencing the video, Then the LLM receives transcript text + 5 `ImageContent` blocks (base64 PNG)
  - Verify: Log "Video frames injected as vision blocks" with frameCount=5

- AC-3.2: Given a video with frames and a NON-vision model (mixtral), When user sends a message, Then the LLM receives only transcript text (no frame downloads occur)
  - Verify: No `downloadFrameContent` calls when `supportsVision=false`

- AC-3.3: Given a video where 2 of 5 frame downloads fail (timeout), When preprocessing completes, Then 3 `ImageContent` blocks are still injected (partial success)
  - Verify: `Promise.allSettled` handles individual failures gracefully

- AC-3.4: Given a video message, When preprocessing starts, Then user's SDK receives `statusUpdate: "Processing video attachment..."` WebSocket event, and `statusClear` after preprocessing

---

## Task T-4: Fix Image Path Gaps

### Files to Modify

- `apps/runtime/src/attachments/message-preprocessor.ts` — Vision check for images, download failure feedback, use resized variant
- `apps/runtime/src/services/execution/reasoning-executor.ts` — Fix ContentBlock[] merge (line 864)
- `apps/runtime/src/attachments/multimodal-service-client.ts` — Replace all `console.error` with structured logger

### Files to Create

None.

### Function Signatures

```typescript
// apps/runtime/src/attachments/multimodal-service-client.ts
// New: download resized variant for image vision
async downloadResizedContent(
  id: string,
  tenantId: string,
): Promise<AttachmentContentResult | null>
// Falls back to downloadAttachmentContent if resized not available
```

### Subtasks (execution order)

1. **ST-4.1: Add `supportsVision`/`maxVideoFrames` to `PreprocessParams` + thread through `transformAttachment`**

   In `message-preprocessor.ts`:
   - Add to `PreprocessParams` interface: `supportsVision?: boolean` (default `false`), `maxVideoFrames?: number` (default `5`)
   - In `preprocess()` (line 70): extract `const { supportsVision = false, maxVideoFrames = 5 } = params;`
   - Update `transformAttachment` signature (line 145) to accept `supportsVision: boolean` and `maxVideoFrames: number` as 6th/7th parameters
   - Update the call at line 99 to pass them through

   Then modify the `case 'image'` branch (line 193-204):

   ```typescript
   case 'image': {
     // NEW: Skip download entirely if model doesn't support vision
     if (!supportsVision) {
       prependedParts.push(
         `[Image attached: ${safeName}${attachment.resizedSizeBytes ? `, ${attachment.mimeType}` : ''} — this model does not support image analysis]`
       );
       break;
     }

     // Prefer resized variant (max 2048px) over original to avoid 20MB+ base64 payloads
     const imageContent = attachment.resizedStorageKey
       ? await this.client.downloadResizedContent(attachment._id, tenantId)
       : await this.client.downloadAttachmentContent(attachment._id, tenantId);

     if (!imageContent) {
       // NEW: User-visible feedback instead of silent drop
       prependedParts.push(`[Image could not be loaded: ${safeName}]`);
       log.warn('Failed to download image attachment content for LLM injection', {
         attachmentId: attachment._id,
         tenantId,
       });
       break;
     }

     contentBlocks.push(imageBytesToContent(imageContent.content, attachment));
     break;
   }
   ```

2. **ST-4.2: Add `downloadResizedContent` to `MultimodalServiceClient`**

   **Note**: The server-side `?variant=resized` route change is in T-2 ST-2.4 (same file, same task owner). This subtask only adds the client method.

   **Client side** (`apps/runtime/src/attachments/multimodal-service-client.ts`): Add `downloadResizedContent()`:

   ```typescript
   async downloadResizedContent(
     id: string,
     tenantId: string,
   ): Promise<AttachmentContentResult | null> {
     try {
       return await this.withCircuitBreaker('downloadResizedContent', async () => {
         const url = `${this.baseUrl}${INTERNAL_PREFIX}/${encodeURIComponent(id)}/content?variant=resized`;
         const res = await fetch(url, {
           method: 'GET',
           headers: { 'X-Tenant-Id': tenantId },
           signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
         });
         if (res.status === 404) return null;
         if (!res.ok) {
           log.error('downloadResizedContent failed', { status: res.status });
           return null;
         }
         const content = Buffer.from(await res.arrayBuffer());
         const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
         return { content, contentType, sizeBytes: content.length };
       });
     } catch (err) {
       log.error('downloadResizedContent failed', {
         error: err instanceof Error ? err.message : String(err),
       });
       // Fallback: try original
       return this.downloadAttachmentContent(id, tenantId);
     }
   }
   ```

   Note: Falls back to `downloadAttachmentContent` (original) on any error.

3. **ST-4.3: Fix ContentBlock[] merge in reasoning-executor**

   In `reasoning-executor.ts` line 861-864, fix the case where `existing` is already a `ContentBlock[]`:

   ```typescript
   const existing = session.conversationHistory[i].content;
   let baseBlocks: ContentBlock[];
   if (Array.isArray(existing)) {
     // Content is already ContentBlock[] — spread existing blocks
     baseBlocks = existing as ContentBlock[];
   } else {
     // Content is a string — wrap in TextContent
     baseBlocks = [
       { type: 'text', text: typeof existing === 'string' ? existing : '' } as TextContent,
     ];
   }
   const contentBlocks: ContentBlock[] = [...baseBlocks, ...session.pendingContentBlocks];
   session.conversationHistory[i].content = contentBlocks;
   ```

4. **ST-4.4: Replace `console.error` with structured logger in `multimodal-service-client.ts`**

   Add logger at top of file:

   ```typescript
   import { createLogger } from '@abl/compiler/platform';
   const log = createLogger('multimodal-client');
   ```

   Replace ALL 16 `console.error(LOG_PREFIX, ...)` calls with `log.error(message, { context })`:
   - Line 168: `log.error('Upload failed', { error: ... })`
   - Line 198: `log.error('getAttachment failed', { status: res.status })`
   - Line 214: `log.error('getAttachment failed', { error: ... })`
   - Line 248: `log.error('listBySession failed', { status: res.status })`
   - Line 264: `log.error('listBySession failed', { error: ... })`
   - Line 302: `log.error('getDownloadUrl failed', { status: res.status })`
   - Line 318: `log.error('getDownloadUrl failed', { error: ... })`
   - Line 345: `log.error('downloadAttachmentContent failed', { status: res.status })`
   - Line 361: `log.error('downloadAttachmentContent failed', { error: ... })`
   - Line 385: `log.error('getStatus failed', { status: res.status })`
   - Line 409: `log.error('getStatus failed', { error: ... })`
   - Line 429: `log.error('deleteAttachment failed', { status: res.status })`
   - Line 433: `log.error('deleteAttachment failed', { error: ... })`
   - Line 452: `log.error('deleteBySession failed', { status: res.status })`
   - Line 456: `log.error('deleteBySession failed', { error: ... })`
   - Line 503: `log.error('retry failed', { error: ... })`

   Remove the `LOG_PREFIX` constant (no longer needed).

### Acceptance Criteria

- AC-4.1: Given an image attachment and a non-vision model, When preprocessing runs, Then no image download occurs and LLM receives `[Image attached: photo.jpg — this model does not support image analysis]`
  - Verify: No `downloadAttachmentContent` call when `supportsVision=false`

- AC-4.2: Given an image with a `resizedStorageKey`, When preprocessing runs with a vision model, Then the resized variant is downloaded instead of the original
  - Verify: Request hits `?variant=resized` endpoint

- AC-4.3: Given an image where download fails, When preprocessing runs, Then LLM receives `[Image could not be loaded: photo.jpg]` instead of silent omission
  - Verify: Text fallback appears in contentBlocks

- AC-4.4: Given conversation history where last user message content is already `ContentBlock[]`, When `pendingContentBlocks` are merged, Then existing blocks are preserved and new blocks appended
  - Verify: `Array.isArray(existing)` branch handles ContentBlock[] correctly

- AC-4.5: All `console.error` calls in `multimodal-service-client.ts` replaced with `createLogger('multimodal-client').error()`
  - Verify: `grep -r "console.error" apps/runtime/src/attachments/multimodal-service-client.ts` returns 0 results

---

## Cross-Task Integration Points

### T-1 → T-2 dependency

T-2 reads `frameStorageKeys` from the Attachment model (added by T-1) to resolve storage keys for frame download.

### T-1 → T-3 dependency

T-3 checks `attachment.frameStorageKeys?.length` to decide whether to attempt frame downloads. The field must exist on `IAttachment`.

### T-2 → T-3 dependency

T-3 calls `client.downloadFrameContent()` (added by T-2) to fetch individual frame binaries.

### T-4 is independent of T-1/T-2/T-3

T-4 touches `runtime` package only. T-4's ST-4.1 adds `supportsVision`/`maxVideoFrames` to `PreprocessParams` and threads them through `transformAttachment`. T-3 (Wave 2) reuses these fields — no conflict since T-4 completes in Wave 1 before T-3 starts.

**The server-side `?variant=resized` route change was moved to T-2 (ST-2.4)** to keep T-4 within `runtime` package scope only, matching the HLD's package assignment.

### Execution Order

```
Wave 1 (parallel):  T-1 (store frames, multimodal-service+database) + T-4 (image fixes, runtime)
Wave 2 (sequential): T-2 (frame endpoint + variant support, multimodal-service) → T-3 (inject frames, runtime)
```

### File Overlap Check

| File                                     | T-1 | T-2 | T-3 | T-4 |
| ---------------------------------------- | :-: | :-: | :-: | :-: |
| `attachment.model.ts` (database)         | ✅  |     |     |     |
| `process-job.ts` (multimodal-svc)        | ✅  |     |     |     |
| `multimodal-service.ts` (multimodal-svc) | ✅  | ✅  |     |     |
| `attachments.ts` routes (multimodal-svc) |     | ✅  |     |     |
| `message-preprocessor.ts` (runtime)      |     |     | ✅  | ✅  |
| `multimodal-service-client.ts` (runtime) |     |     | ✅  | ✅  |
| `reasoning-executor.ts` (runtime)        |     |     |     | ✅  |
| `runtime-executor.ts` (runtime)          |     |     | ✅  |     |

**Overlap in `message-preprocessor.ts`**: T-4 modifies `PreprocessParams` interface + image case (line 193-204) + `transformAttachment` signature. T-3 modifies video case (line 220-225) and uses the updated signature. Wave ordering (T-4 first) prevents conflicts.

**Overlap in `multimodal-service-client.ts`**: T-4 replaces `console.error` + adds `downloadResizedContent()`. T-3 adds `downloadFrameContent()`. Different method additions — safe in Wave ordering.

**Overlap in `multimodal-service.ts`**: T-1 modifies `deleteAttachment()` (line 409-411), T-2 adds `downloadFrameContent()` method. Different locations — safe for parallel.

### Design Note: `Promise.allSettled` vs `Promise.all`

The HLD mentions `Promise.all` for parallel frame downloads. The LLD uses `Promise.allSettled` instead — this is a deliberate improvement to enable partial success (3/5 frames OK → send 3, don't fail all). `Promise.all` would abort on the first failure.

### Design Note: Resized images are WebP

The multimodal-service's `processImage` stores resized variants as `image/webp` (quality 80). When `downloadResizedContent` is used, the `imageBytesToContent` function should use the download response's `contentType` (which will be `image/webp`), NOT `attachment.mimeType` (which is the original upload type). The current `imageBytesToContent` uses `attachment.mimeType` — the implementer must update it to prefer the actual download content type:

```typescript
function imageBytesToContent(
  buffer: Buffer,
  attachment: IAttachment,
  actualContentType?: string,
): ImageContent {
  const mediaType = actualContentType || attachment.mimeType || 'image/png';
  // ...
}
```

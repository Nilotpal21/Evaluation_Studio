# Multimodal Vision Enhancement — High-Level Design

## What

Enhance the agent chat's multimodal pipeline so that **video key frames are sent to the LLM as vision content blocks** (alongside the existing transcript), and **fix 5 gaps in the image path** that can cause silent failures, provider errors, or data loss. Today, video uploads extract 10 key frames via FFmpeg but discard them — the LLM only sees a transcript. Images work for vision models but fail ungracefully for non-vision models and have no size guardrails.

## Architecture Approach

### Packages Changed

| Package                   | What Changes                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `apps/multimodal-service` | Store extracted video key frames using existing `StorageProvider` (same S3/local store already in use — zero new infrastructure) |
| `packages/database`       | Add `frameStorageKeys: string[]` field to Attachment model                                                                       |
| `apps/runtime`            | Resolve video frames as `ImageContent[]` blocks via parallel download; add vision capability gating; fix image path gaps         |

### Storage Decision: Reuse Existing Multimodal-Service Store

Both `apps/multimodal-service` and `apps/search-ai` already have storage configured:

| Service            | Interface                         | Default Bucket           | Env Vars                                               |
| ------------------ | --------------------------------- | ------------------------ | ------------------------------------------------------ |
| multimodal-service | `StorageProvider` (stream-based)  | `attachments`            | `STORAGE_PROVIDER`, `STORAGE_BUCKET`, `STORAGE_REGION` |
| search-ai          | `S3StorageService` (buffer-based) | `abl-platform-documents` | Same env vars                                          |

**Decision: Reuse multimodal-service's existing `StorageProvider`** — the `processVideo()` function already has `storageProvider` injected via DI. Frames are stored as siblings of the original under the same key prefix. **Zero new infrastructure, zero new deployment config, zero new S3 buckets.** Same store that already holds the `original`, `resized`, and `thumbnail` variants.

### Data Flow

```
                         TODAY (video)
                         ─────────────
User uploads video
  → multimodal-service: FFmpeg extracts 10 PNG frames
  → frames DISCARDED, only transcript text saved
  → runtime preprocessor reads text field from attachment metadata (~0ms)
  → LLM sees TEXT ONLY (blind to visual content)

                         AFTER (video)
                         ────────────
User uploads video
  → multimodal-service: FFmpeg extracts 10 PNG frames
  → frames uploaded to EXISTING store as {base}/frame-{N}   ← NEW (same StorageProvider, same bucket)
  → frameStorageKeys[] saved on Attachment document          ← NEW
  → runtime preprocessor at message time:
      1. Reads frameStorageKeys from attachment metadata      ← NEW
      2. Downloads frames via multimodal-service IN PARALLEL  ← NEW (Promise.all, not sequential)
      3. Checks model vision capability                       ← NEW
      4. If vision: sends transcript TEXT + frame IMAGES
      5. If no vision: sends transcript TEXT only (frames skipped)
  → LLM sees TRANSCRIPT + KEY FRAME IMAGES (can see the video)

                         AFTER (images — fixes)
                         ──────────────────────
  → Vision capability check before sending ImageContent      ← NEW
  → Non-vision fallback: "[Image: name, WxH — model does    ← NEW
    not support vision]"
  → Use resized variant instead of original for base64       ← NEW
  → User feedback when image download fails                  ← NEW
  → Fix ContentBlock[] merge in reasoning-executor           ← NEW
```

### Endpoint Visibility

**All endpoints are INTERNAL only.** The multimodal-service is an internal service (`http://multimodal-service:3006`) not exposed to the public internet. The new frame download endpoint follows the existing pattern:

| Endpoint                                      | Visibility | Pattern                               |
| --------------------------------------------- | ---------- | ------------------------------------- |
| `GET /internal/attachments/:id/content`       | Internal   | Existing — serves original file       |
| `GET /internal/attachments/:id/frames/:index` | Internal   | **NEW** — serves individual frame PNG |
| `POST /internal/attachments`                  | Internal   | Existing — upload                     |

No public endpoints are added. The runtime (also internal) calls the multimodal-service. End users never call these directly — they interact via the SDK WebSocket which triggers the runtime.

### Latency & Scaling Analysis

#### Current Latency Baseline

| Attachment Type | Current Preprocessing Latency | What Happens                                                   |
| --------------- | ----------------------------- | -------------------------------------------------------------- |
| Image           | ~60-225ms                     | Download original binary + base64 encode                       |
| Video           | ~0ms                          | Read `processedContent` text field from metadata (no download) |
| Document        | ~0ms                          | Read `processedContent` text field from metadata               |

#### Proposed Latency Impact (Video Frames)

**Key finding: Today's preprocessing loop is SEQUENTIAL** (`for...of await` in `message-preprocessor.ts:90-106`). Adding 5 sequential frame downloads would cost 250-1000ms.

**Mitigation: Parallel frame downloads with `Promise.all`:**

| Scenario               | Sequential (current pattern) | Parallel (proposed) |
| ---------------------- | ---------------------------- | ------------------- |
| 5 frames × ~100ms each | ~500ms                       | ~100-150ms          |
| 5 frames × ~200ms each | ~1000ms                      | ~200-300ms          |
| Network degraded       | ~2500ms+                     | ~500-600ms          |

**Additional safeguards:**

- **Per-frame timeout**: 5s per frame (not the global 30s HTTP timeout)
- **Partial success**: If 3/5 frames download, send those 3 — don't discard all on partial failure
- **Circuit breaker**: Wire the existing `MultimodalCircuitBreaker` into the preprocessing path (currently missing — it's constructed but unused)
- **Skip on non-vision model**: If model doesn't support vision, skip frame download entirely (saves 100% of latency)

#### User Experience During Preprocessing

**Current gap**: Between `response_start` and the first LLM chunk, the user sees nothing. This gap is currently ~100ms for images, would grow to ~200-300ms for video frames.

**Mitigation**: Emit a `statusUpdate` WebSocket event ("Processing video attachment...") before frame downloads begin. The `FillerMessageService` and `ServerMessages.statusUpdate()` mechanisms already exist but are unused during preprocessing.

#### Scaling Considerations

| Concern                            | Impact                                           | Mitigation                                                                                   |
| ---------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **Memory per message**             | 5 frames × ~200KB = ~1MB buffers + ~1.3MB base64 | Bounded by maxFrames=5, frames are small PNGs                                                |
| **Concurrent messages with video** | N concurrent × ~2.3MB each                       | Same as current image path (one 20MB image = 46MB with base64) — frames are actually lighter |
| **S3 operations at upload time**   | +5-10 PUTs per video upload                      | One-time cost during async BullMQ processing, not on critical path                           |
| **S3 operations at message time**  | +5 GETs per video message                        | Parallel, small objects, within multimodal-service (internal network)                        |
| **Token cost**                     | 5 frames × ~1600 tokens = ~8K tokens             | Configurable, skip if non-vision model                                                       |
| **Multimodal-service load**        | +5 proxy requests per video message              | Internal HTTP, small payloads, add connection keep-alive                                     |

**Conclusion**: The latency impact is ~200-300ms (parallel downloads), which is less than a single large image download today. Memory impact is lighter than the current image path. The main risk is network degradation, mitigated by per-frame timeouts and partial success.

### Key Integration Points

1. **multimodal-service StorageProvider**: Existing DI-injected storage — frames stored as `{base}/frame-{N}` (same bucket, same provider, no new config)
2. **multimodal-service internal API**: New `GET /internal/attachments/:id/frames/:index` endpoint (internal only)
3. **runtime preprocessor ↔ reasoning-executor**: `pendingContentBlocks` already supports `ImageContent[]` — video frames use the same path
4. **runtime ↔ model capabilities**: Vision check via existing `ModelCapabilities.supportsVision` — skip frame download entirely for non-vision models
5. **Attachment model**: New `frameStorageKeys: string[]` field — cleanup handled in existing `deleteAttachment` path

## Decisions & Tradeoffs

### D-1: Reuse multimodal-service StorageProvider vs. SearchAI S3StorageService vs. new store

**Chose: Reuse multimodal-service's existing `StorageProvider`**

- `processVideo()` already receives `storageProvider` via DI — zero wiring changes
- Frames stored as siblings: `{tenantId}/{projectId}/{sessionId}/{attachmentId}/frame-{N}`
- Same bucket, same credentials, same lifecycle (90-day retention)
- SearchAI's `S3StorageService` is buffer-based with different key patterns — would introduce cross-service coupling
- Tradeoff: Frames are tied to multimodal-service's storage lifecycle, but that's correct since they're attachment derivatives

### D-2: Parallel frame download vs. sequential (existing pattern)

**Chose: Parallel download with `Promise.all`** for video frames

- Current image path is sequential (one image per attachment) — acceptable for 1-2 images
- Video frames are 5+ objects that MUST all be ready together — parallel is essential
- Individual frame failures handled gracefully (partial success)
- Tradeoff: Slightly more complex error handling, but 5x latency improvement

### D-3: Send ALL frames vs. configurable frame count to LLM

**Chose: Configurable max frames** (default 5, max 10)

- 10 frames × ~1600 tokens each = 16K tokens — significant context cost
- Default 5 frames balances visual understanding with token budget
- Configurable via `AttachmentConfig.maxVideoFramesForVision` (project/tenant level)
- Tradeoff: Fewer frames = less visual context, but keeps token usage predictable

### D-4: New frames endpoint vs. extend existing `/content` endpoint

**Chose: New `GET /internal/attachments/:id/frames/:index` endpoint** (INTERNAL only)

- Existing `/content` always serves original — adding frame logic would complicate it
- Separate endpoint keeps concerns clean, easy to add caching headers later
- Tradeoff: One more internal route, but simpler implementation

### D-5: Vision capability — strip images silently vs. text fallback

**Chose: Text fallback with description**

- User should know WHY the agent can't see their image/video
- Image fallback: `[Image attached: router_error.jpg, 1200x800px — this model does not support image analysis]`
- Video: Skip frame download entirely for non-vision models (saves latency), transcript still sent
- Tradeoff: Slightly verbose, but user can act on it

### D-6: Image size cap — use resized variant from multimodal-service

**Chose: Use `resizedStorageKey` variant** (max 2048px, already created by sharp during processing)

- Multimodal-service already creates a resized variant for every image — currently unused by runtime
- Download resized instead of original when available → ~200KB-1MB instead of up to 20MB
- Falls back to original if resized doesn't exist
- Tradeoff: Slightly lower quality, but prevents 27MB base64 payloads blowing provider limits

### D-7: Preprocessing status feedback

**Chose: Emit `statusUpdate` WebSocket event** before frame downloads

- Uses existing `ServerMessages.statusUpdate()` mechanism
- Message: "Processing video..." shown to user while frames download
- Tradeoff: Minor code change in runtime-executor preprocessing block

## Task Decomposition

| Task                                      | Package(s)                   | Independent?  | Est. Files | Description                                                                                                         |
| ----------------------------------------- | ---------------------------- | ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| T-1: Store video key frames in S3         | multimodal-service, database | Yes           | 3-4        | Upload extracted frames via existing StorageProvider, add `frameStorageKeys` to Attachment model, cleanup in delete |
| T-2: Serve video frames via internal API  | multimodal-service           | No (T-1)      | 2          | New internal endpoint `GET /internal/attachments/:id/frames/:index`                                                 |
| T-3: Inject video frames as vision blocks | runtime                      | No (T-1, T-2) | 4-5        | Parallel frame download in preprocessor, vision check, status WebSocket event, partial success handling             |
| T-4: Fix image path gaps                  | runtime                      | Yes           | 3-4        | Vision check, silent drop fix, ContentBlock[] merge fix, use resized variant, replace console.error with logger     |

**Wave plan:**

- **Wave 1** (parallel): T-1 + T-4 (independent)
- **Wave 2** (sequential): T-2 → T-3 (depend on T-1)

## Out of Scope

- **PDF vision** — PDFs use Tika text extraction; sending PDF pages as images is a separate feature
- **Real-time video streaming** — only uploaded video files are supported
- **Frame selection intelligence** — using scene-change detection instead of interval sampling (future optimization)
- **Audio waveform visualization** — audio stays transcript-only
- **Arch AI builder chat** — separate upload path, not affected by these changes
- **Token budget enforcement** — pre-flight token counting per message is a platform-wide concern, not scoped here
- **New S3 buckets or storage infrastructure** — reusing existing multimodal-service storage
- **Public-facing endpoints** — all new endpoints are internal-only

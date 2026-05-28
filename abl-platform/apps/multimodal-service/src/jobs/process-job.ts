/**
 * Process Worker - Content Processing Pipeline Stage
 *
 * Handles category-specific content processing:
 *   - image: resize, thumbnail, EXIF strip via ImageProcessor
 *   - document: text extraction via DocumentParser (TikaParser)
 *   - audio: transcription via TranscriptionProvider (WhisperTranscriber)
 *   - video: audio extraction + transcription via VideoProcessor + TranscriptionProvider,
 *            key frame extraction via VideoProcessor
 *
 * Pipeline flow:
 *   scan -> validate -> process (this) -> index
 *
 * On success, enqueues an index-job for the next pipeline stage.
 * On failure, marks the attachment as failed with a descriptive error.
 * Never crashes the worker — all errors are caught and recorded.
 *
 * All DB queries are tenant-scoped: `findOne({ _id, tenantId })`.
 */

import { createHash } from 'crypto';
import { Readable } from 'stream';
import type { Job } from 'bullmq';
import { Attachment, DemoVisionConfig } from '@agent-platform/database';
import type { StorageProvider } from '@agent-platform/shared';
import { detectPII } from '@abl/compiler/platform';
import type { PIIDetection } from '@abl/compiler/platform';
import type { ImageProcessResult } from '../processing/image-processor.js';
import type { DocumentParser, DocumentParseResult } from '../processing/document-parser-tika.js';
import type { TranscriptionProvider } from '../processing/transcriber-whisper.js';
import type { VideoProcessor } from '../processing/video-processor-ffmpeg.js';
import type { ProcessJobData, IndexJobData } from './queues.js';
import { QUEUE_NAMES, workerLog, workerError } from './queues.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const WORKER_NAME = 'process';

/** Segment names for storage key variants. */
const STORAGE_KEY_SEGMENT_ORIGINAL = 'original';
const STORAGE_KEY_SEGMENT_RESIZED = 'resized';
const STORAGE_KEY_SEGMENT_THUMBNAIL = 'thumbnail';
const STORAGE_KEY_SEGMENT_FRAME_PREFIX = 'frame-';

/** Content type for WebP images (default output of ImageProcessor). */
const CONTENT_TYPE_WEBP = 'image/webp';

/** SHA-256 hash algorithm for content hashing. */
const HASH_ALGORITHM = 'sha256';

// =============================================================================
// TYPES
// =============================================================================

/** Interface for the image processor dependency (matches ImageProcessor.process). */
export interface ImageProcessorDep {
  process(inputBuffer: Buffer): Promise<ImageProcessResult>;
}

export interface ProcessWorkerDeps {
  storageProvider: StorageProvider;
  imageProcessor: ImageProcessorDep;
  documentParser: DocumentParser;
  transcriptionProvider: TranscriptionProvider;
  videoProcessor: VideoProcessor;
  indexQueue: { add(name: string, data: IndexJobData): Promise<unknown> };
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a process worker processor function.
 *
 * Accepts dependencies via a factory pattern so providers and queues can be
 * injected (and mocked in tests) without module-level singletons.
 */
export function createProcessWorker(
  deps: ProcessWorkerDeps,
): (job: Job<ProcessJobData>) => Promise<void> {
  const {
    storageProvider,
    imageProcessor,
    documentParser,
    transcriptionProvider,
    videoProcessor,
    indexQueue,
  } = deps;

  return async (job: Job<ProcessJobData>): Promise<void> => {
    const { attachmentId, tenantId, category } = job.data;

    workerLog(WORKER_NAME, 'Starting content processing', { attachmentId, tenantId, category });

    // 1. Load attachment (tenant-scoped)
    const attachment = await Attachment.findOne({ _id: attachmentId, tenantId }).lean();

    if (!attachment) {
      workerLog(WORKER_NAME, 'Attachment not found, skipping', { attachmentId, tenantId });
      return;
    }

    try {
      switch (category) {
        case 'image':
          await processImage(
            { attachmentId, tenantId, storageKey: attachment.storageKey },
            { storageProvider, imageProcessor, indexQueue },
          );
          break;

        case 'document':
          await processDocument(
            {
              attachmentId,
              tenantId,
              storageKey: attachment.storageKey,
              mimeType: attachment.mimeType,
              filename: attachment.originalFilename,
              sizeBytes: attachment.sizeBytes,
            },
            { storageProvider, documentParser, indexQueue },
          );
          break;

        case 'audio':
          await processAudio(
            {
              attachmentId,
              tenantId,
              storageKey: attachment.storageKey,
              mimeType: attachment.mimeType,
            },
            { storageProvider, transcriptionProvider, indexQueue },
          );
          break;

        case 'video':
          await processVideo(
            {
              attachmentId,
              tenantId,
              storageKey: attachment.storageKey,
            },
            { storageProvider, videoProcessor, transcriptionProvider, indexQueue },
          );
          break;

        default:
          workerLog(WORKER_NAME, 'Unknown category, marking as failed', {
            attachmentId,
            category,
          });
          await Attachment.findOneAndUpdate(
            { _id: attachmentId, tenantId },
            {
              $set: {
                processingStatus: 'failed',
                processingError: `Unsupported category: ${category}`,
              },
            },
          );
          break;
      }
    } catch (err: unknown) {
      workerError(WORKER_NAME, 'Process job failed', err);

      await Attachment.findOneAndUpdate(
        { _id: attachmentId, tenantId },
        {
          $set: {
            processingStatus: 'failed',
            processingError: err instanceof Error ? err.message : String(err),
          },
        },
      ).catch((dbErr: unknown) => {
        workerError(WORKER_NAME, 'Failed to update processing status after error', dbErr);
      });
    }
  };
}

// =============================================================================
// IMAGE PROCESSING
// =============================================================================

interface ImageProcessContext {
  attachmentId: string;
  tenantId: string;
  storageKey: string;
}

interface ImageProcessDeps {
  storageProvider: StorageProvider;
  imageProcessor: ImageProcessorDep;
  indexQueue: { add(name: string, data: IndexJobData): Promise<unknown> };
}

/**
 * Process an image attachment:
 * 1. Download original from storage
 * 2. Run through ImageProcessor (resize + thumbnail + EXIF strip)
 * 3. Upload resized and thumbnail variants to storage
 * 4. Update attachment record with variant keys and metadata
 * 5. Enqueue index job
 */
async function processImage(ctx: ImageProcessContext, deps: ImageProcessDeps): Promise<void> {
  const { attachmentId, tenantId, storageKey } = ctx;
  const { storageProvider, imageProcessor, indexQueue } = deps;

  // 1. Download original file
  const download = await storageProvider.download(storageKey);
  const buffer = await streamToBuffer(download.body);

  // 2. Process image (resize, thumbnail, EXIF strip)
  const result = await imageProcessor.process(buffer);

  // 3. Compute storage keys for variants
  const resizedKey = deriveStorageKey(storageKey, STORAGE_KEY_SEGMENT_RESIZED);
  const thumbnailKey = deriveStorageKey(storageKey, STORAGE_KEY_SEGMENT_THUMBNAIL);

  // 4. Upload resized image
  await storageProvider.upload({
    key: resizedKey,
    body: Readable.from(result.resized),
    contentType: CONTENT_TYPE_WEBP,
    sizeBytes: result.resizedSizeBytes,
    metadata: {
      attachmentId,
      tenantId,
      variant: STORAGE_KEY_SEGMENT_RESIZED,
      format: result.format,
    },
  });

  // 5. Upload thumbnail
  await storageProvider.upload({
    key: thumbnailKey,
    body: Readable.from(result.thumbnail),
    contentType: CONTENT_TYPE_WEBP,
    sizeBytes: result.thumbnailSizeBytes,
    metadata: {
      attachmentId,
      tenantId,
      variant: STORAGE_KEY_SEGMENT_THUMBNAIL,
      format: result.format,
    },
  });

  // 6. Update attachment record
  await Attachment.findOneAndUpdate(
    { _id: attachmentId, tenantId },
    {
      $set: {
        resizedStorageKey: resizedKey,
        resizedSizeBytes: result.resizedSizeBytes,
        thumbnailStorageKey: thumbnailKey,
        exifStripped: result.exifStripped,
        processingStatus: 'completed',
        processingEngine: 'sharp',
        processedAt: new Date(),
      },
    },
  );

  workerLog(WORKER_NAME, 'Image processing completed', { attachmentId });

  // 7. Enqueue index job
  await indexQueue.add(QUEUE_NAMES.INDEX, { attachmentId, tenantId });
}

// =============================================================================
// DOCUMENT PROCESSING
// =============================================================================

interface DocumentProcessContext {
  attachmentId: string;
  tenantId: string;
  storageKey: string;
  mimeType: string;
  filename: string;
  sizeBytes: number;
}

interface DocumentProcessDeps {
  storageProvider: StorageProvider;
  documentParser: DocumentParser;
  indexQueue: { add(name: string, data: IndexJobData): Promise<unknown> };
}

/**
 * Process a document attachment:
 * 1. Download original from storage
 * 2. Parse text content via DocumentParser
 * 3. Compute SHA-256 hash of extracted text
 * 4. Update attachment record with content and hash
 * 5. Enqueue index job
 */
async function processDocument(
  ctx: DocumentProcessContext,
  deps: DocumentProcessDeps,
): Promise<void> {
  const { attachmentId, tenantId, storageKey, mimeType, filename, sizeBytes } = ctx;
  const { storageProvider, documentParser, indexQueue } = deps;

  // 1. Download original file
  const download = await storageProvider.download(storageKey);

  // 2. Parse document text
  const parseResult: DocumentParseResult = await documentParser.parse({
    fileStream: download.body,
    mimeType,
    filename,
    sizeBytes,
  });

  if (!parseResult.success) {
    // Parser returned a structured failure — mark attachment as failed
    workerLog(WORKER_NAME, 'Document parsing failed', {
      attachmentId,
      error: parseResult.error,
    });

    await Attachment.findOneAndUpdate(
      { _id: attachmentId, tenantId },
      {
        $set: {
          processingStatus: 'failed',
          processingEngine: parseResult.engine,
          processingError: parseResult.error ?? 'Document parsing failed',
          processedAt: new Date(),
        },
      },
    );
    return;
  }

  // 3. Compute SHA-256 hash of extracted content
  const contentHash = createHash(HASH_ALGORITHM)
    .update(parseResult.text ?? '')
    .digest('hex');

  // 3b. Run PII detection (non-blocking)
  const piiResult = scanForPII(parseResult.text);

  // 4. Update attachment record
  await Attachment.findOneAndUpdate(
    { _id: attachmentId, tenantId },
    {
      $set: {
        processedContent: parseResult.text,
        processedContentHash: contentHash,
        processingStatus: 'completed',
        processingEngine: parseResult.engine,
        processedAt: new Date(),
        hasPII: piiResult.hasPII,
        piiDetections: piiResult.piiDetections,
      },
    },
  );

  workerLog(WORKER_NAME, 'Document processing completed', {
    attachmentId,
    contentHash,
    hasPII: piiResult.hasPII,
  });

  // 5. Enqueue index job
  await indexQueue.add(QUEUE_NAMES.INDEX, { attachmentId, tenantId });
}

// =============================================================================
// AUDIO PROCESSING
// =============================================================================

interface AudioProcessContext {
  attachmentId: string;
  tenantId: string;
  storageKey: string;
  mimeType: string;
}

interface AudioProcessDeps {
  storageProvider: StorageProvider;
  transcriptionProvider: TranscriptionProvider;
  indexQueue: { add(name: string, data: IndexJobData): Promise<unknown> };
}

/**
 * Process an audio attachment:
 * 1. Download original from storage
 * 2. Transcribe via TranscriptionProvider
 * 3. Compute SHA-256 hash of transcript
 * 4. Update attachment record with transcript and metadata
 * 5. Enqueue index job
 */
async function processAudio(ctx: AudioProcessContext, deps: AudioProcessDeps): Promise<void> {
  const { attachmentId, tenantId, storageKey, mimeType } = ctx;
  const { storageProvider, transcriptionProvider, indexQueue } = deps;

  // 1. Download original file
  const download = await storageProvider.download(storageKey);

  // 2. Transcribe audio
  const result = await transcriptionProvider.transcribe({
    audioStream: download.body,
    mimeType,
  });

  if (!result.success) {
    // Transcription returned a structured failure — mark attachment as failed
    workerLog(WORKER_NAME, 'Audio transcription failed', {
      attachmentId,
      error: result.error,
    });

    await Attachment.findOneAndUpdate(
      { _id: attachmentId, tenantId },
      {
        $set: {
          processingStatus: 'failed',
          processingEngine: result.engine,
          processingError: result.error ?? 'Audio transcription failed',
          processedAt: new Date(),
        },
      },
    );
    return;
  }

  // 3. Compute SHA-256 hash of transcript
  const contentHash = createHash(HASH_ALGORITHM)
    .update(result.text ?? '')
    .digest('hex');

  // 3b. Run PII detection (non-blocking)
  const piiResult = scanForPII(result.text);

  // 4. Update attachment record
  await Attachment.findOneAndUpdate(
    { _id: attachmentId, tenantId },
    {
      $set: {
        processedContent: result.text,
        processedContentHash: contentHash,
        processingStatus: 'completed',
        processingEngine: result.engine,
        processedAt: new Date(),
        hasPII: piiResult.hasPII,
        piiDetections: piiResult.piiDetections,
      },
    },
  );

  workerLog(WORKER_NAME, 'Audio processing completed', {
    attachmentId,
    contentHash,
    hasPII: piiResult.hasPII,
  });

  // 5. Enqueue index job
  await indexQueue.add(QUEUE_NAMES.INDEX, { attachmentId, tenantId });
}

// =============================================================================
// VIDEO PROCESSING
// =============================================================================

/** Processing engine label for video pipeline (ffmpeg audio extraction + whisper transcription). */
const VIDEO_PROCESSING_ENGINE = 'ffmpeg+whisper';

/** Processing engine label for demo vision (pre-seeded frames, no FFmpeg). */
const DEMO_VISION_ENGINE = 'demo-vision';

/** Maximum key frames to extract from a video. */
const VIDEO_MAX_KEY_FRAMES = 10;

/** Maximum demo frames to load from NFS. */
const DEMO_MAX_FRAMES = 5;

interface VideoProcessContext {
  attachmentId: string;
  tenantId: string;
  storageKey: string;
}

interface VideoProcessDeps {
  storageProvider: StorageProvider;
  videoProcessor: VideoProcessor;
  transcriptionProvider: TranscriptionProvider;
  indexQueue: { add(name: string, data: IndexJobData): Promise<unknown> };
}

/**
 * Check if this attachment belongs to a demo-vision-enabled project.
 * If so, load pre-seeded frames from NFS, store them as frameStorageKeys,
 * mark the attachment as completed, and enqueue the index job.
 *
 * Returns true if demo frames were loaded (caller should return early).
 * Returns false if no demo config exists (caller should proceed normally).
 *
 * Remove this function when FFmpeg is provisioned in the container image.
 */
async function tryLoadDemoFrames(
  attachmentId: string,
  tenantId: string,
  storageKey: string,
  deps: VideoProcessDeps,
): Promise<boolean> {
  const { storageProvider, indexQueue } = deps;

  // 1. Load attachment to get projectId
  const attachment = await Attachment.findOne({ _id: attachmentId, tenantId }).lean();
  if (!attachment?.projectId) {
    return false;
  }

  // 2. Check for demo config
  const demoConfig = await DemoVisionConfig.findOne({
    tenantId,
    projectId: attachment.projectId,
    enabled: true,
  }).lean();

  if (!demoConfig) {
    return false;
  }

  workerLog(WORKER_NAME, 'Demo vision enabled — loading pre-seeded frames', {
    attachmentId,
    projectId: attachment.projectId,
    framePrefix: demoConfig.framePrefix,
  });

  // 3. Load pre-seeded frames from NFS
  const frameStorageKeys: string[] = [];
  for (let i = 0; i < DEMO_MAX_FRAMES; i++) {
    // Try common image formats — NFS frames may be PNG, WebP, or JPEG
    const frameName = `frame-${String(i).padStart(2, '0')}`;
    const candidates = [
      { ext: 'png', mime: 'image/png' },
      { ext: 'webp', mime: 'image/webp' },
      { ext: 'jpg', mime: 'image/jpeg' },
    ];
    let foundKey: string | null = null;
    let foundMime = 'image/png';
    for (const { ext, mime } of candidates) {
      const candidateKey = `${demoConfig.framePrefix}${frameName}.${ext}`;
      if (await storageProvider.exists(candidateKey)) {
        foundKey = candidateKey;
        foundMime = mime;
        break;
      }
    }
    if (!foundKey) {
      break;
    }

    // Copy frame to the attachment's own storage path so cleanup works correctly
    const targetKey = deriveStorageKey(storageKey, `${STORAGE_KEY_SEGMENT_FRAME_PREFIX}${i}`);
    const frameDownload = await storageProvider.download(foundKey);
    const frameBuffer = await streamToBuffer(frameDownload.body);

    await storageProvider.upload({
      key: targetKey,
      body: Readable.from(frameBuffer),
      contentType: foundMime,
      sizeBytes: frameBuffer.length,
      metadata: { attachmentId, tenantId, frameIndex: String(i), source: 'demo-vision' },
    });

    frameStorageKeys.push(targetKey);
  }

  if (frameStorageKeys.length === 0) {
    workerLog(WORKER_NAME, 'Demo vision: no frames found at prefix', {
      attachmentId,
      framePrefix: demoConfig.framePrefix,
    });
    return false;
  }

  // 3b. Load pre-seeded transcript from NFS (optional — mirrors real audio extraction flow)
  let transcriptText: string | null = null;
  const transcriptKey = `${demoConfig.framePrefix}transcript.txt`;
  const transcriptExists = await storageProvider.exists(transcriptKey);
  if (transcriptExists) {
    const transcriptDownload = await storageProvider.download(transcriptKey);
    const transcriptBuffer = await streamToBuffer(transcriptDownload.body);
    transcriptText = transcriptBuffer.toString('utf-8').trim();
    workerLog(WORKER_NAME, 'Demo vision: loaded pre-seeded transcript', {
      attachmentId,
      transcriptLength: transcriptText.length,
    });
  }

  // 4. Build processedContent (matches real processVideo format: Transcript + Key Frames)
  const contentParts: string[] = [];
  if (transcriptText) {
    contentParts.push(`Transcript:\n${transcriptText}`);
  }
  contentParts.push(
    `Key Frames: ${frameStorageKeys.length} pre-seeded frames loaded for visual analysis.`,
  );
  const processedContent = contentParts.join('\n\n');
  const contentHash = createHash(HASH_ALGORITHM).update(processedContent).digest('hex');
  const piiResult = scanForPII(processedContent);

  // 5. Update attachment record
  await Attachment.findOneAndUpdate(
    { _id: attachmentId, tenantId },
    {
      $set: {
        processedContent,
        processedContentHash: contentHash,
        processingStatus: 'completed',
        processingEngine: DEMO_VISION_ENGINE,
        processedAt: new Date(),
        hasPII: piiResult.hasPII,
        piiDetections: piiResult.piiDetections,
        frameStorageKeys,
      },
    },
  );

  workerLog(WORKER_NAME, 'Demo vision processing completed', {
    attachmentId,
    frameCount: frameStorageKeys.length,
  });

  // 6. Enqueue index job
  await indexQueue.add(QUEUE_NAMES.INDEX, { attachmentId, tenantId });

  return true;
}

/**
 * Process a video attachment:
 * 1. Download original from storage, buffer in memory
 * 2. Extract audio via VideoProcessor, transcribe via TranscriptionProvider
 * 3. Extract key frames via VideoProcessor
 * 4. Merge transcript + frame info into processedContent
 * 5. Compute SHA-256 hash
 * 6. Update attachment record
 * 7. Enqueue index job
 */
async function processVideo(ctx: VideoProcessContext, deps: VideoProcessDeps): Promise<void> {
  const { attachmentId, tenantId, storageKey } = ctx;
  const { storageProvider, videoProcessor, transcriptionProvider, indexQueue } = deps;

  // ── Demo vision: check for pre-seeded frames before FFmpeg ──────────
  // When a DemoVisionConfig exists for this project, load pre-extracted
  // frames from NFS instead of calling FFmpeg (which isn't in the container).
  // Remove this block when FFmpeg is provisioned in the Dockerfile.
  const demoResult = await tryLoadDemoFrames(attachmentId, tenantId, storageKey, deps);
  if (demoResult) {
    return; // Demo frames loaded, attachment updated, index job enqueued
  }

  // 1. Download original file and buffer it (we need two streams from it)
  const download = await storageProvider.download(storageKey);
  const buffer = await streamToBuffer(download.body);

  // 2. Extract audio and transcribe
  let transcriptText: string | null = null;

  const audioResult = await videoProcessor.extractAudio({
    videoStream: Readable.from(buffer),
    outputFormat: 'wav',
  });

  if (audioResult.success && audioResult.audioStream) {
    const transcriptionResult = await transcriptionProvider.transcribe({
      audioStream: audioResult.audioStream,
      mimeType: 'audio/wav',
    });

    if (transcriptionResult.success) {
      transcriptText = transcriptionResult.text;
    } else {
      workerLog(WORKER_NAME, 'Video audio transcription failed', {
        attachmentId,
        error: transcriptionResult.error,
      });
    }
  } else if (!audioResult.success) {
    workerLog(WORKER_NAME, 'Video audio extraction failed', {
      attachmentId,
      error: audioResult.error,
    });
  }

  // 3. Extract key frames
  let frameCount = 0;
  let frameTimestamps: number[] = [];

  const framesResult = await videoProcessor.extractKeyFrames({
    videoStream: Readable.from(buffer),
    strategy: 'interval',
    maxFrames: VIDEO_MAX_KEY_FRAMES,
  });

  const frameStorageKeys: string[] = [];
  if (framesResult.success) {
    frameCount = framesResult.totalFramesExtracted;
    frameTimestamps = framesResult.timestamps;

    // Upload each extracted frame buffer to storage in parallel
    if (framesResult.frames.length > 0) {
      const uploadResults = await Promise.allSettled(
        framesResult.frames.map(async (frameBuffer, i) => {
          const frameKey = deriveStorageKey(storageKey, `${STORAGE_KEY_SEGMENT_FRAME_PREFIX}${i}`);
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

      workerLog(WORKER_NAME, 'Video frame upload completed', {
        attachmentId,
        totalFrames: framesResult.frames.length,
        uploadedFrames: frameStorageKeys.length,
        failedFrames: framesResult.frames.length - frameStorageKeys.length,
      });
    }
  }

  // 4. Check if we have any usable content
  if (transcriptText === null && frameCount === 0) {
    // Both audio and frame extraction failed — mark as failed
    workerLog(WORKER_NAME, 'Video processing failed: no transcript and no frames', {
      attachmentId,
    });

    await Attachment.findOneAndUpdate(
      { _id: attachmentId, tenantId },
      {
        $set: {
          processingStatus: 'failed',
          processingEngine: VIDEO_PROCESSING_ENGINE,
          processingError: 'Video processing failed: could not extract audio or key frames',
          processedAt: new Date(),
        },
      },
    );
    return;
  }

  // 5. Build processedContent by merging transcript + frame info
  const contentParts: string[] = [];

  if (transcriptText !== null) {
    contentParts.push(`Transcript:\n${transcriptText}`);
  } else {
    contentParts.push('[Audio extraction/transcription failed]');
  }

  if (frameCount > 0) {
    const timestampStr = frameTimestamps.map((t) => `${t}s`).join(', ');
    contentParts.push(`Key Frames: ${frameCount} frames extracted at timestamps: ${timestampStr}`);
  }

  const processedContent = contentParts.join('\n\n');

  // 6. Compute SHA-256 hash
  const contentHash = createHash(HASH_ALGORITHM).update(processedContent).digest('hex');

  // 6b. Run PII detection (non-blocking)
  const piiResult = scanForPII(processedContent);

  // 7. Update attachment record
  await Attachment.findOneAndUpdate(
    { _id: attachmentId, tenantId },
    {
      $set: {
        processedContent,
        processedContentHash: contentHash,
        processingStatus: 'completed',
        processingEngine: VIDEO_PROCESSING_ENGINE,
        processedAt: new Date(),
        hasPII: piiResult.hasPII,
        piiDetections: piiResult.piiDetections,
        frameStorageKeys,
      },
    },
  );

  workerLog(WORKER_NAME, 'Video processing completed', {
    attachmentId,
    contentHash,
    hasPII: piiResult.hasPII,
  });

  // 8. Enqueue index job
  await indexQueue.add(QUEUE_NAMES.INDEX, { attachmentId, tenantId });
}

// =============================================================================
// PII DETECTION (NON-BLOCKING)
// =============================================================================

interface PIIScanResult {
  hasPII: boolean;
  piiDetections: PIIDetection[];
}

/**
 * Run PII detection on text content. Non-blocking: if detection fails,
 * logs the error and returns a safe default (no PII detected).
 */
function scanForPII(text: string | null): PIIScanResult {
  if (!text) {
    return { hasPII: false, piiDetections: [] };
  }

  try {
    const result = detectPII(text);
    return {
      hasPII: result.hasPII,
      piiDetections: result.detections,
    };
  } catch (err: unknown) {
    workerError(WORKER_NAME, 'PII detection failed (non-blocking)', err);
    return { hasPII: false, piiDetections: [] };
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Derive a storage key for a variant by replacing the last segment.
 *
 * Given: `tenant-1/project-1/session-1/att-001/original`
 * With variant `resized`, returns: `tenant-1/project-1/session-1/att-001/resized`
 */
function deriveStorageKey(originalKey: string, variant: string): string {
  const lastSlash = originalKey.lastIndexOf('/');
  if (lastSlash === -1) {
    return `${originalKey}/${variant}`;
  }
  return `${originalKey.substring(0, lastSlash)}/${variant}`;
}

/**
 * Collect a Readable stream into a single Buffer.
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

// Export for testing
export {
  deriveStorageKey,
  STORAGE_KEY_SEGMENT_ORIGINAL,
  STORAGE_KEY_SEGMENT_RESIZED,
  STORAGE_KEY_SEGMENT_THUMBNAIL,
  STORAGE_KEY_SEGMENT_FRAME_PREFIX,
};

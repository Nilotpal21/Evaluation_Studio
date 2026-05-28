/**
 * PII Pipeline Integration Tests (I-0.1 through I-0.4)
 *
 * Integration tests that use the REAL detectPII function from
 * @abl/compiler/platform AND a REAL MongoDB (via MongoMemoryServer)
 * instead of mocking them. Only external services (document parser,
 * transcription, storage, video/image processors, queue) are mocked
 * via dependency injection — no vi.mock() calls for codebase components.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { Job } from 'bullmq';
import { Attachment } from '@agent-platform/database';
import type { StorageProvider } from '@agent-platform/shared';
import type { ProcessJobData } from '../jobs/queues.js';
import type { ImageProcessorDep } from '../jobs/process-job.js';
import type { DocumentParser } from '../processing/document-parser-tika.js';
import type {
  TranscriptionProvider,
  TranscriptionResult,
} from '../processing/transcriber-whisper.js';
import type { VideoProcessor } from '../processing/video-processor-ffmpeg.js';

// Suppress noisy log output during tests
process.env.LOG_LEVEL = 'error';

// =============================================================================
// MONGODB SETUP (real in-memory instance)
// =============================================================================

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.20' } });
  await mongoose.connect(mongod.getUri(), { dbName: 'test-pii-pipeline' });
}, 60_000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
  }
}, 30_000);

beforeEach(async () => {
  await Attachment.deleteMany({});
});

// =============================================================================
// HELPERS — DI mocks for external services (not codebase components)
// =============================================================================

function makeStorageProvider(overrides?: Partial<StorageProvider>): StorageProvider {
  return {
    name: 'test-storage',
    upload: vi.fn().mockResolvedValue({ storageKey: 'mock-key', etag: 'mock-etag' }),
    download: vi.fn().mockResolvedValue({
      body: Readable.from([Buffer.from('fake-file-bytes')]),
      contentType: 'application/octet-stream',
      sizeBytes: 15,
    }),
    getSignedUrl: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    exists: vi.fn(),
    copy: vi.fn(),
    healthCheck: vi.fn(),
    ...overrides,
  };
}

function makeImageProcessor(overrides?: Partial<ImageProcessorDep>): ImageProcessorDep {
  return {
    process: vi.fn().mockResolvedValue({
      resized: Buffer.from('resized-image-data'),
      resizedWidth: 1024,
      resizedHeight: 768,
      resizedSizeBytes: 18,
      thumbnail: Buffer.from('thumbnail-image-data'),
      thumbnailWidth: 256,
      thumbnailHeight: 256,
      thumbnailSizeBytes: 20,
      format: 'webp',
      exifStripped: true,
    }),
    ...overrides,
  };
}

function makeDocumentParser(overrides?: Partial<DocumentParser>): DocumentParser {
  return {
    name: 'tika',
    parse: vi.fn().mockResolvedValue({
      success: true,
      text: 'Extracted document text content',
      characterCount: 30,
      engine: 'tika',
    }),
    supportedMimeTypes: vi.fn().mockReturnValue(['application/pdf']),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 10 }),
    ...overrides,
  };
}

function makeTranscriptionProvider(
  overrides?: Partial<TranscriptionProvider>,
): TranscriptionProvider {
  return {
    name: 'whisper',
    transcribe: vi.fn().mockResolvedValue({
      success: true,
      text: 'Hello, this is a test transcription.',
      language: 'en',
      durationSeconds: 12.5,
      segments: [
        { start: 0, end: 6, text: 'Hello, this is' },
        { start: 6, end: 12.5, text: 'a test transcription.' },
      ],
      engine: 'whisper',
    } satisfies TranscriptionResult),
    supportedFormats: vi.fn().mockReturnValue(['audio/mpeg', 'audio/wav']),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 15 }),
    ...overrides,
  };
}

function makeVideoProcessor(overrides?: Partial<VideoProcessor>): VideoProcessor {
  return {
    name: 'ffmpeg',
    extractAudio: vi.fn().mockResolvedValue({
      success: true,
      audioStream: Readable.from([Buffer.from('fake-audio-data')]),
      durationSeconds: 30,
      format: 'wav',
    }),
    extractKeyFrames: vi.fn().mockResolvedValue({
      success: true,
      frames: [Buffer.from('frame-1'), Buffer.from('frame-2'), Buffer.from('frame-3')],
      timestamps: [0, 10, 20],
      totalFramesExtracted: 3,
    }),
    ...overrides,
  };
}

function makeIndexQueue() {
  return { add: vi.fn().mockResolvedValue(undefined) };
}

function makeJob(data: ProcessJobData): Job<ProcessJobData> {
  return { data } as Job<ProcessJobData>;
}

/**
 * Insert a real Attachment document into MongoDB via the Mongoose model.
 * This is acceptable for integration tests — we are testing the processing
 * pipeline against a real database, not testing API routes.
 */
async function seedAttachment(overrides?: Record<string, unknown>) {
  const doc = {
    _id: 'att-001',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    messageId: null,
    originalFilename: 'report.pdf',
    mimeType: 'application/pdf',
    category: 'document',
    sizeBytes: 5000,
    storageProvider: 'test-storage',
    storageKey: 'tenant-1/project-1/session-1/att-001/original',
    storageBucket: 'test-bucket',
    encrypted: false,
    encryptionKeyVersion: 0,
    scanStatus: 'clean',
    hasPII: false,
    piiDetections: [],
    exifStripped: false,
    processingMode: 'full',
    processingStatus: 'pending',
    embeddingStatus: 'pending',
    retryCount: 0,
    ...overrides,
  };

  return Attachment.create(doc);
}

/**
 * Read an Attachment document from real MongoDB by _id and tenantId.
 */
async function readAttachment(attachmentId: string, tenantId: string) {
  return Attachment.findOne({ _id: attachmentId, tenantId }).lean();
}

// =============================================================================
// TESTS
// =============================================================================

describe('PII Pipeline Integration (real detectPII + real MongoDB)', () => {
  let storageProvider: ReturnType<typeof makeStorageProvider>;
  let imageProcessor: ReturnType<typeof makeImageProcessor>;
  let documentParser: ReturnType<typeof makeDocumentParser>;
  let transcriptionProvider: ReturnType<typeof makeTranscriptionProvider>;
  let videoProcessor: ReturnType<typeof makeVideoProcessor>;
  let indexQueue: ReturnType<typeof makeIndexQueue>;
  let createProcessWorker: typeof import('../jobs/process-job.js').createProcessWorker;

  beforeEach(async () => {
    vi.clearAllMocks();

    storageProvider = makeStorageProvider();
    imageProcessor = makeImageProcessor();
    documentParser = makeDocumentParser();
    transcriptionProvider = makeTranscriptionProvider();
    videoProcessor = makeVideoProcessor();
    indexQueue = makeIndexQueue();

    const mod = await import('../jobs/process-job.js');
    createProcessWorker = mod.createProcessWorker;
  });

  // ---------------------------------------------------------------------------
  // I-0.1: Upload doc → process → hasPII flag set (REAL detectPII + REAL DB)
  // ---------------------------------------------------------------------------

  it('I-0.1: document with email → real detectPII sets hasPII: true with email detection', async () => {
    const textWithEmail = 'Please contact support at user@example.com for help.';

    // Seed a real attachment into MongoDB
    await seedAttachment({ _id: 'att-001', tenantId: 'tenant-1' });

    // Configure the document parser to return text containing an email
    (documentParser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      text: textWithEmail,
      characterCount: textWithEmail.length,
      engine: 'tika',
    });

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(
      makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'document' }),
    );

    // Query the real DB to verify the update
    const updated = await readAttachment('att-001', 'tenant-1');
    expect(updated).not.toBeNull();
    expect(updated!.processingStatus).toBe('completed');
    expect(updated!.hasPII).toBe(true);
    expect(updated!.piiDetections.length).toBeGreaterThanOrEqual(1);

    // The real detectPII should find the email
    const emailDetection = updated!.piiDetections.find((d) => d.type === 'email');
    expect(emailDetection).toBeDefined();
    expect(emailDetection!.value).toBe('[REDACTED_EMAIL]');
    expect(updated!.processedContent!.slice(emailDetection!.start, emailDetection!.end)).toBe(
      'user@example.com',
    );
  });

  // ---------------------------------------------------------------------------
  // I-0.2: Re-upload same content hash preserves PII flags
  // ---------------------------------------------------------------------------

  it('I-0.2: re-upload same content hash preserves PII flags from first upload', async () => {
    const textWithEmail = 'Contact admin@corp.com for support.';
    const contentHash = createHash('sha256').update(textWithEmail).digest('hex');

    // Seed two real attachments into MongoDB
    await seedAttachment({ _id: 'att-first', tenantId: 'tenant-1' });
    await seedAttachment({ _id: 'att-second', tenantId: 'tenant-1' });

    // Configure the document parser to return text containing an email
    (documentParser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      text: textWithEmail,
      characterCount: textWithEmail.length,
      engine: 'tika',
    });

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });

    // First upload: process and detect PII
    await processor(
      makeJob({ attachmentId: 'att-first', tenantId: 'tenant-1', category: 'document' }),
    );

    // Query the real DB after first processing
    const firstResult = await readAttachment('att-first', 'tenant-1');
    expect(firstResult).not.toBeNull();
    expect(firstResult!.hasPII).toBe(true);
    expect(firstResult!.piiDetections.length).toBeGreaterThanOrEqual(1);
    expect(firstResult!.processedContentHash).toBe(contentHash);

    // Second upload: process the same content
    await processor(
      makeJob({ attachmentId: 'att-second', tenantId: 'tenant-1', category: 'document' }),
    );

    // Query the real DB after second processing
    const secondResult = await readAttachment('att-second', 'tenant-1');
    expect(secondResult).not.toBeNull();
    expect(secondResult!.hasPII).toBe(true);

    // Both should have the same PII detections (same content → same PII).
    // Strip Mongoose-generated subdocument _id fields before comparison.
    const stripIds = (
      detections: Array<{ type: string; start: number; end: number; value: string }>,
    ) => detections.map(({ type, start, end, value }) => ({ type, start, end, value }));

    expect(stripIds(secondResult!.piiDetections)).toEqual(stripIds(firstResult!.piiDetections));
  });

  // ---------------------------------------------------------------------------
  // I-0.3: Clean document → hasPII: false
  // ---------------------------------------------------------------------------

  it('I-0.3: clean document with no PII → hasPII: false, empty piiDetections', async () => {
    // Seed a real attachment into MongoDB
    await seedAttachment({ _id: 'att-001', tenantId: 'tenant-1' });

    // Use content with no PII
    (documentParser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      text: 'This document has no sensitive information whatsoever.',
      characterCount: 53,
      engine: 'tika',
    });

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(
      makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'document' }),
    );

    // Query the real DB to verify
    const updated = await readAttachment('att-001', 'tenant-1');
    expect(updated).not.toBeNull();
    expect(updated!.processingStatus).toBe('completed');
    expect(updated!.hasPII).toBe(false);
    expect(updated!.piiDetections).toEqual([]);

    // Index job should be enqueued
    expect(indexQueue.add).toHaveBeenCalledWith('attachment-index', {
      attachmentId: 'att-001',
      tenantId: 'tenant-1',
    });
  });

  // ---------------------------------------------------------------------------
  // I-0.4: Large doc with many PII instances (50+ emails)
  // ---------------------------------------------------------------------------

  it('I-0.4: large document with 50+ email addresses — all detected by real detectPII', async () => {
    // Generate text with 60 unique email addresses
    const emailCount = 60;
    const lines: string[] = [];
    for (let i = 0; i < emailCount; i++) {
      lines.push(`Employee ${i}: employee${i}@company.com`);
    }
    const largeText = lines.join('\n');

    // Seed a real attachment into MongoDB
    await seedAttachment({ _id: 'att-001', tenantId: 'tenant-1' });

    (documentParser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      text: largeText,
      characterCount: largeText.length,
      engine: 'tika',
    });

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });

    const start = Date.now();
    await processor(
      makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'document' }),
    );
    const elapsed = Date.now() - start;

    // Query the real DB to verify
    const updated = await readAttachment('att-001', 'tenant-1');
    expect(updated).not.toBeNull();
    expect(updated!.processingStatus).toBe('completed');
    expect(updated!.hasPII).toBe(true);

    // All 60 emails should be detected
    const emailDetections = updated!.piiDetections.filter((d) => d.type === 'email');
    expect(emailDetections.length).toBe(emailCount);

    // Each email should be correctly captured
    for (let i = 0; i < emailCount; i++) {
      const found = emailDetections.find(
        (d) => updated!.processedContent!.slice(d.start, d.end) === `employee${i}@company.com`,
      );
      expect(found).toBeDefined();
      expect(found!.value).toBe('[REDACTED_EMAIL]');
    }

    // Performance check: should complete within a reasonable time (5 seconds)
    expect(elapsed).toBeLessThan(5000);
  });
});

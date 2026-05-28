/**
 * Process Job PII Detection Tests
 *
 * Verifies that PII detection runs on processedContent after text
 * extraction in document, audio, and video processing pipelines.
 * Images are skipped (no text extraction).
 *
 * PII detection failure must be non-blocking — processing should
 * still complete successfully even if PII scan throws.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type { Job } from 'bullmq';
import type { StorageProvider } from '@agent-platform/shared';
import type { ProcessJobData, IndexJobData } from '../queues.js';
import type { ImageProcessorDep } from '../process-job.js';
import type { DocumentParser, DocumentParseResult } from '../../processing/document-parser-tika.js';
import type {
  TranscriptionProvider,
  TranscriptionResult,
} from '../../processing/transcriber-whisper.js';
import type { VideoProcessor } from '../../processing/video-processor-ffmpeg.js';

// =============================================================================
// MOCK: Mongoose Attachment model
// =============================================================================

const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();

const mockDemoConfigFindOne = vi.fn();

vi.mock('@agent-platform/database', () => ({
  Attachment: {
    findOne: (...args: unknown[]) => {
      const result = mockFindOne(...args);
      return { lean: () => result };
    },
    findOneAndUpdate: mockFindOneAndUpdate,
  },
  DemoVisionConfig: {
    findOne: (...args: unknown[]) => {
      const result = mockDemoConfigFindOne(...args);
      return { lean: () => result };
    },
  },
}));

// =============================================================================
// MOCK: PII Detector
// =============================================================================

const mockDetectPII = vi.fn();

vi.mock('@abl/compiler/platform', () => ({
  detectPII: (...args: unknown[]) => mockDetectPII(...args),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// =============================================================================
// HELPERS
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

function makeAttachmentDoc(overrides?: Record<string, unknown>) {
  return {
    _id: 'att-001',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    originalFilename: 'report.pdf',
    mimeType: 'application/pdf',
    category: 'document',
    sizeBytes: 5000,
    storageKey: 'tenant-1/project-1/session-1/att-001/original',
    scanStatus: 'clean',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('process-job PII detection', () => {
  let storageProvider: ReturnType<typeof makeStorageProvider>;
  let imageProcessor: ReturnType<typeof makeImageProcessor>;
  let documentParser: ReturnType<typeof makeDocumentParser>;
  let transcriptionProvider: ReturnType<typeof makeTranscriptionProvider>;
  let videoProcessor: ReturnType<typeof makeVideoProcessor>;
  let indexQueue: ReturnType<typeof makeIndexQueue>;
  let createProcessWorker: typeof import('../process-job.js').createProcessWorker;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockFindOne.mockResolvedValue(null);
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockDemoConfigFindOne.mockResolvedValue(null); // No demo vision config by default

    // Default: no PII detected
    mockDetectPII.mockReturnValue({
      hasPII: false,
      detections: [],
      redacted: '',
    });

    storageProvider = makeStorageProvider();
    imageProcessor = makeImageProcessor();
    documentParser = makeDocumentParser();
    transcriptionProvider = makeTranscriptionProvider();
    videoProcessor = makeVideoProcessor();
    indexQueue = makeIndexQueue();

    const mod = await import('../process-job.js');
    createProcessWorker = mod.createProcessWorker;
  });

  // ---------------------------------------------------------------------------
  // 0-U1: Document with email detected → hasPII: true, piiDetections contains email
  // ---------------------------------------------------------------------------

  it('0-U1: document with email → hasPII: true, piiDetections contains email', async () => {
    const extractedText = 'Contact us at user@example.com for details';
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    (documentParser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      text: extractedText,
      characterCount: extractedText.length,
      engine: 'tika',
    });

    mockDetectPII.mockReturnValue({
      hasPII: true,
      detections: [{ type: 'email', start: 14, end: 34, value: '[REDACTED_EMAIL]' }],
      redacted: 'Contact us at [REDACTED_EMAIL] for details',
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

    // PII detection should have been called with the extracted text
    expect(mockDetectPII).toHaveBeenCalledWith(extractedText);

    // Update should include hasPII: true and piiDetections array
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          processingStatus: 'completed',
          hasPII: true,
          piiDetections: [{ type: 'email', start: 14, end: 34, value: '[REDACTED_EMAIL]' }],
        }),
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 0-U2: Document with no PII → hasPII: false, piiDetections: []
  // ---------------------------------------------------------------------------

  it('0-U2: document with no PII → hasPII: false, piiDetections: []', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    mockDetectPII.mockReturnValue({
      hasPII: false,
      detections: [],
      redacted: 'Extracted document text content',
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

    expect(mockDetectPII).toHaveBeenCalled();

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          processingStatus: 'completed',
          hasPII: false,
          piiDetections: [],
        }),
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 0-U3: Audio transcript with SSN → hasPII: true
  // ---------------------------------------------------------------------------

  it('0-U3: audio transcript with SSN → hasPII: true', async () => {
    const transcriptText = 'My SSN is 123-45-6789';
    const attachment = makeAttachmentDoc({
      category: 'audio',
      mimeType: 'audio/mpeg',
      originalFilename: 'recording.mp3',
    });
    mockFindOne.mockResolvedValue(attachment);
    (transcriptionProvider.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      text: transcriptText,
      language: 'en',
      durationSeconds: 5,
      segments: [],
      engine: 'whisper',
    });

    mockDetectPII.mockReturnValue({
      hasPII: true,
      detections: [{ type: 'ssn', start: 10, end: 21, value: '[REDACTED_SSN]' }],
      redacted: 'My SSN is [REDACTED_SSN]',
    });

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'audio' }));

    expect(mockDetectPII).toHaveBeenCalledWith(transcriptText);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          hasPII: true,
          piiDetections: [{ type: 'ssn', start: 10, end: 21, value: '[REDACTED_SSN]' }],
        }),
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 0-U4: Video transcript with credit card → hasPII: true
  // ---------------------------------------------------------------------------

  it('0-U4: video transcript with credit card → hasPII: true', async () => {
    const transcriptText = 'Card number is 4532 0158 1234 5678';
    (transcriptionProvider.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      text: transcriptText,
      language: 'en',
      durationSeconds: 10,
      segments: [],
      engine: 'whisper',
    });

    const attachment = makeAttachmentDoc({
      category: 'video',
      mimeType: 'video/mp4',
      originalFilename: 'meeting.mp4',
    });
    mockFindOne.mockResolvedValue(attachment);

    // The processedContent for video merges transcript + frame info
    const expectedContent =
      `Transcript:\n${transcriptText}\n\n` +
      'Key Frames: 3 frames extracted at timestamps: 0s, 10s, 20s';

    mockDetectPII.mockReturnValue({
      hasPII: true,
      detections: [{ type: 'credit_card', start: 27, end: 46, value: '4532 0158 1234 5678' }],
      redacted: expectedContent.replace('4532 0158 1234 5678', '[REDACTED_CARD]'),
    });

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'video' }));

    // PII detection should be called with the merged processedContent
    expect(mockDetectPII).toHaveBeenCalledWith(expectedContent);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          hasPII: true,
          piiDetections: expect.arrayContaining([expect.objectContaining({ type: 'credit_card' })]),
        }),
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 0-U5: Image category skipped → containsPII never called
  // ---------------------------------------------------------------------------

  it('0-U5: image category → detectPII is never called', async () => {
    const attachment = makeAttachmentDoc({
      category: 'image',
      mimeType: 'image/png',
      originalFilename: 'photo.png',
    });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'image' }));

    expect(mockDetectPII).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 0-U6: Multiple PII types in one doc → piiDetections has correct count
  // ---------------------------------------------------------------------------

  it('0-U6: multiple PII types → piiDetections has all detections', async () => {
    const extractedText = 'Email: user@test.com, SSN: 123-45-6789, Phone: 555-123-4567';
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    (documentParser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      text: extractedText,
      characterCount: extractedText.length,
      engine: 'tika',
    });

    mockDetectPII.mockReturnValue({
      hasPII: true,
      detections: [
        { type: 'email', start: 7, end: 21, value: '[REDACTED_EMAIL]' },
        { type: 'ssn', start: 28, end: 39, value: '[REDACTED_SSN]' },
        { type: 'phone', start: 48, end: 60, value: '[REDACTED_PHONE]' },
      ],
      redacted: 'Email: [REDACTED_EMAIL], SSN: [REDACTED_SSN], Phone: [REDACTED_PHONE]',
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

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          hasPII: true,
          piiDetections: expect.arrayContaining([
            expect.objectContaining({ type: 'email' }),
            expect.objectContaining({ type: 'ssn' }),
            expect.objectContaining({ type: 'phone' }),
          ]),
        }),
      },
    );

    // Verify exact count
    const updateCall = mockFindOneAndUpdate.mock.calls[0];
    expect(updateCall[1].$set.piiDetections).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // 0-U7: PII detection failure is non-blocking → processingStatus still 'completed'
  // ---------------------------------------------------------------------------

  it('0-U7: PII detection failure is non-blocking → still completes', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    // detectPII throws
    mockDetectPII.mockImplementation(() => {
      throw new Error('PII detection engine crashed');
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

    // Should still complete — PII failure is non-blocking
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          processingStatus: 'completed',
        }),
      },
    );

    // Should still enqueue index job
    expect(indexQueue.add).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 0-U8: Empty processedContent → detectPII not called
  // ---------------------------------------------------------------------------

  it('0-U8: empty processedContent (null text) → detectPII not called', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    (documentParser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      text: null,
      characterCount: 0,
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

    expect(mockDetectPII).not.toHaveBeenCalled();
  });
});

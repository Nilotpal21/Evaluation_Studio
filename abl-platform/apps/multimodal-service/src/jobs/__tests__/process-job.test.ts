import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
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
// MOCK: PII Detector (default: no PII detected)
// =============================================================================

vi.mock('@abl/compiler/platform', () => ({
  detectPII: () => ({ hasPII: false, detections: [], redacted: '' }),
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
      body: Readable.from([Buffer.from('fake-image-bytes')]),
      contentType: 'image/png',
      sizeBytes: 17,
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
    originalFilename: 'photo.png',
    mimeType: 'image/png',
    category: 'image',
    sizeBytes: 1024,
    storageKey: 'tenant-1/project-1/session-1/att-001/original',
    scanStatus: 'clean',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('createProcessWorker', () => {
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
  // IMAGE: Full happy path
  // ---------------------------------------------------------------------------

  it('image category: calls ImageProcessor, uploads resized + thumbnail, updates record', async () => {
    const attachment = makeAttachmentDoc();
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

    // Should look up attachment with tenant-scoped query
    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-1' });

    // Should download original from storage
    expect(storageProvider.download).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-001/original',
    );

    // Should call ImageProcessor.process with the downloaded buffer
    expect(imageProcessor.process).toHaveBeenCalledWith(expect.any(Buffer));

    // Should upload resized image
    expect(storageProvider.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'tenant-1/project-1/session-1/att-001/resized',
        contentType: 'image/webp',
        sizeBytes: 18,
      }),
    );

    // Should upload thumbnail
    expect(storageProvider.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'tenant-1/project-1/session-1/att-001/thumbnail',
        contentType: 'image/webp',
        sizeBytes: 20,
      }),
    );

    // Should update attachment record with image processing results
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          resizedStorageKey: 'tenant-1/project-1/session-1/att-001/resized',
          resizedSizeBytes: 18,
          thumbnailStorageKey: 'tenant-1/project-1/session-1/att-001/thumbnail',
          exifStripped: true,
          processingStatus: 'completed',
          processingEngine: 'sharp',
          processedAt: expect.any(Date),
        },
      },
    );
  });

  // ---------------------------------------------------------------------------
  // IMAGE: Verify storage key format
  // ---------------------------------------------------------------------------

  it('image category: stores correct storage keys for resized and thumbnail', async () => {
    const attachment = makeAttachmentDoc({
      storageKey: 'tenant-X/proj-Y/sess-Z/att-ABC/original',
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

    // Resized key replaces 'original' with 'resized'
    expect(storageProvider.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'tenant-X/proj-Y/sess-Z/att-ABC/resized',
      }),
    );

    // Thumbnail key replaces 'original' with 'thumbnail'
    expect(storageProvider.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'tenant-X/proj-Y/sess-Z/att-ABC/thumbnail',
      }),
    );

    // Attachment record should have the correct keys
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          resizedStorageKey: 'tenant-X/proj-Y/sess-Z/att-ABC/resized',
          thumbnailStorageKey: 'tenant-X/proj-Y/sess-Z/att-ABC/thumbnail',
        }),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // IMAGE: Enqueues index-job on success
  // ---------------------------------------------------------------------------

  it('image category: enqueues index-job on success', async () => {
    const attachment = makeAttachmentDoc();
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

    expect(indexQueue.add).toHaveBeenCalledWith('attachment-index', {
      attachmentId: 'att-001',
      tenantId: 'tenant-1',
    });
  });

  // ---------------------------------------------------------------------------
  // DOCUMENT: Full happy path
  // ---------------------------------------------------------------------------

  it('document category: calls TikaParser, stores processedContent', async () => {
    const attachment = makeAttachmentDoc({
      category: 'document',
      mimeType: 'application/pdf',
      originalFilename: 'report.pdf',
      sizeBytes: 5000,
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
    await processor(
      makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'document' }),
    );

    // Should download from storage
    expect(storageProvider.download).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-001/original',
    );

    // Should call documentParser.parse with correct params
    expect(documentParser.parse).toHaveBeenCalledWith({
      fileStream: expect.anything(),
      mimeType: 'application/pdf',
      filename: 'report.pdf',
      sizeBytes: 5000,
    });

    // Should update attachment with parsed content
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processedContent: 'Extracted document text content',
          processedContentHash: expect.any(String),
          processingStatus: 'completed',
          processingEngine: 'tika',
          processedAt: expect.any(Date),
          hasPII: false,
          piiDetections: [],
        },
      },
    );

    // Should enqueue index job
    expect(indexQueue.add).toHaveBeenCalledWith('attachment-index', {
      attachmentId: 'att-001',
      tenantId: 'tenant-1',
    });
  });

  // ---------------------------------------------------------------------------
  // DOCUMENT: Computes correct SHA-256 hash
  // ---------------------------------------------------------------------------

  it('document category: computes processedContentHash (SHA-256)', async () => {
    const extractedText = 'Extracted document text content';
    const expectedHash = createHash('sha256').update(extractedText).digest('hex');

    const attachment = makeAttachmentDoc({
      category: 'document',
      mimeType: 'application/pdf',
      originalFilename: 'report.pdf',
      sizeBytes: 5000,
    });
    mockFindOne.mockResolvedValue(attachment);
    (documentParser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      text: extractedText,
      characterCount: extractedText.length,
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

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          processedContentHash: expectedHash,
        }),
      },
    );
  });

  // ---------------------------------------------------------------------------
  // DOCUMENT: Parser failure marks failed
  // ---------------------------------------------------------------------------

  it('document category: parser failure marks failed', async () => {
    const attachment = makeAttachmentDoc({
      category: 'document',
      mimeType: 'application/pdf',
      originalFilename: 'corrupt.pdf',
      sizeBytes: 500,
    });
    mockFindOne.mockResolvedValue(attachment);
    (documentParser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      text: null,
      characterCount: 0,
      engine: 'tika',
      error: 'Encrypted PDF cannot be parsed',
    } satisfies DocumentParseResult);

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

    // Should mark as failed with the parser error
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processingStatus: 'failed',
          processingEngine: 'tika',
          processingError: 'Encrypted PDF cannot be parsed',
          processedAt: expect.any(Date),
        },
      },
    );

    // Should NOT enqueue index job
    expect(indexQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AUDIO: Full happy path — transcribes and stores content
  // ---------------------------------------------------------------------------

  it('audio category: transcribes audio, stores processedContent with hash, enqueues index', async () => {
    const attachment = makeAttachmentDoc({
      category: 'audio',
      mimeType: 'audio/mpeg',
      originalFilename: 'recording.mp3',
    });
    mockFindOne.mockResolvedValue(attachment);

    const transcriptText = 'Hello, this is a test transcription.';
    const expectedHash = createHash('sha256').update(transcriptText).digest('hex');

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'audio' }));

    // Should download from storage
    expect(storageProvider.download).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-001/original',
    );

    // Should call transcriptionProvider.transcribe with the downloaded stream and mimeType
    expect(transcriptionProvider.transcribe).toHaveBeenCalledWith({
      audioStream: expect.anything(),
      mimeType: 'audio/mpeg',
    });

    // Should update attachment with transcript content
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processedContent: transcriptText,
          processedContentHash: expectedHash,
          processingStatus: 'completed',
          processingEngine: 'whisper',
          processedAt: expect.any(Date),
          hasPII: false,
          piiDetections: [],
        },
      },
    );

    // Should enqueue index job
    expect(indexQueue.add).toHaveBeenCalledWith('attachment-index', {
      attachmentId: 'att-001',
      tenantId: 'tenant-1',
    });
  });

  // ---------------------------------------------------------------------------
  // AUDIO: Transcription failure marks attachment as failed
  // ---------------------------------------------------------------------------

  it('audio category: transcription failure marks attachment as failed', async () => {
    const attachment = makeAttachmentDoc({
      category: 'audio',
      mimeType: 'audio/mpeg',
      originalFilename: 'corrupt.mp3',
    });
    mockFindOne.mockResolvedValue(attachment);

    (transcriptionProvider.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      text: null,
      language: null,
      durationSeconds: 0,
      segments: [],
      engine: 'whisper',
      error: 'Unsupported MIME type: audio/x-unknown',
    } satisfies TranscriptionResult);

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'audio' }));

    // Should mark as failed with the transcription error
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processingStatus: 'failed',
          processingEngine: 'whisper',
          processingError: 'Unsupported MIME type: audio/x-unknown',
          processedAt: expect.any(Date),
        },
      },
    );

    // Should NOT enqueue index job
    expect(indexQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // VIDEO: Full happy path — extracts audio, transcribes, extracts frames
  // ---------------------------------------------------------------------------

  it('video category: extracts audio + transcribes + extracts key frames, stores merged content', async () => {
    const attachment = makeAttachmentDoc({
      category: 'video',
      mimeType: 'video/mp4',
      originalFilename: 'meeting.mp4',
    });
    mockFindOne.mockResolvedValue(attachment);

    const transcriptText = 'Hello, this is a test transcription.';
    const expectedContent =
      `Transcript:\n${transcriptText}\n\n` +
      'Key Frames: 3 frames extracted at timestamps: 0s, 10s, 20s';
    const expectedHash = createHash('sha256').update(expectedContent).digest('hex');

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'video' }));

    // Should download from storage
    expect(storageProvider.download).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-001/original',
    );

    // Should call videoProcessor.extractAudio with wav output
    expect(videoProcessor.extractAudio).toHaveBeenCalledWith({
      videoStream: expect.anything(),
      outputFormat: 'wav',
    });

    // Should transcribe the extracted audio
    expect(transcriptionProvider.transcribe).toHaveBeenCalledWith({
      audioStream: expect.anything(),
      mimeType: 'audio/wav',
    });

    // Should call videoProcessor.extractKeyFrames
    expect(videoProcessor.extractKeyFrames).toHaveBeenCalledWith({
      videoStream: expect.anything(),
      strategy: 'interval',
      maxFrames: 10,
    });

    // Should update attachment with merged content + frameStorageKeys
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processedContent: expectedContent,
          processedContentHash: expectedHash,
          processingStatus: 'completed',
          processingEngine: 'ffmpeg+whisper',
          processedAt: expect.any(Date),
          hasPII: false,
          piiDetections: [],
          frameStorageKeys: [
            'tenant-1/project-1/session-1/att-001/frame-0',
            'tenant-1/project-1/session-1/att-001/frame-1',
            'tenant-1/project-1/session-1/att-001/frame-2',
          ],
        },
      },
    );

    // Should enqueue index job
    expect(indexQueue.add).toHaveBeenCalledWith('attachment-index', {
      attachmentId: 'att-001',
      tenantId: 'tenant-1',
    });
  });

  // ---------------------------------------------------------------------------
  // VIDEO: Audio extraction failure — still completes with fallback content
  // ---------------------------------------------------------------------------

  it('video category: audio extraction failure produces fallback content with frame info', async () => {
    const attachment = makeAttachmentDoc({
      category: 'video',
      mimeType: 'video/mp4',
      originalFilename: 'silent.mp4',
    });
    mockFindOne.mockResolvedValue(attachment);

    // Audio extraction fails
    (videoProcessor.extractAudio as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      durationSeconds: 0,
      format: 'wav',
      error: 'No audio track found',
    });

    const expectedContent =
      '[Audio extraction/transcription failed]\n\n' +
      'Key Frames: 3 frames extracted at timestamps: 0s, 10s, 20s';
    const expectedHash = createHash('sha256').update(expectedContent).digest('hex');

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'video' }));

    // Should NOT attempt transcription since audio extraction failed
    expect(transcriptionProvider.transcribe).not.toHaveBeenCalled();

    // Should still update with fallback content + frame info + frameStorageKeys
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processedContent: expectedContent,
          processedContentHash: expectedHash,
          processingStatus: 'completed',
          processingEngine: 'ffmpeg+whisper',
          processedAt: expect.any(Date),
          hasPII: false,
          piiDetections: [],
          frameStorageKeys: [
            'tenant-1/project-1/session-1/att-001/frame-0',
            'tenant-1/project-1/session-1/att-001/frame-1',
            'tenant-1/project-1/session-1/att-001/frame-2',
          ],
        },
      },
    );

    // Should still enqueue index job (partial content is still indexable)
    expect(indexQueue.add).toHaveBeenCalledWith('attachment-index', {
      attachmentId: 'att-001',
      tenantId: 'tenant-1',
    });
  });

  // ---------------------------------------------------------------------------
  // VIDEO: Both audio and frame extraction fail — marks as failed
  // ---------------------------------------------------------------------------

  it('video category: both audio and frame extraction fail marks attachment as failed', async () => {
    const attachment = makeAttachmentDoc({
      category: 'video',
      mimeType: 'video/mp4',
      originalFilename: 'corrupt.mp4',
    });
    mockFindOne.mockResolvedValue(attachment);

    // Both operations fail
    (videoProcessor.extractAudio as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      durationSeconds: 0,
      format: 'wav',
      error: 'Corrupt video file',
    });
    (videoProcessor.extractKeyFrames as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      frames: [],
      timestamps: [],
      totalFramesExtracted: 0,
      error: 'Cannot read video stream',
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

    // Should mark as failed
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processingStatus: 'failed',
          processingEngine: 'ffmpeg+whisper',
          processingError: 'Video processing failed: could not extract audio or key frames',
          processedAt: expect.any(Date),
        },
      },
    );

    // Should NOT enqueue index job
    expect(indexQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // UNKNOWN CATEGORY: Marks as failed with error
  // ---------------------------------------------------------------------------

  it('unknown category: marks failed with error', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(
      makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'spreadsheet' }),
    );

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processingStatus: 'failed',
          processingError: 'Unsupported category: spreadsheet',
        },
      },
    );

    // Should NOT download, process, or enqueue index
    expect(storageProvider.download).not.toHaveBeenCalled();
    expect(indexQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // ATTACHMENT NOT FOUND: Logs and returns gracefully
  // ---------------------------------------------------------------------------

  it('attachment not found: logs and returns without crashing', async () => {
    mockFindOne.mockResolvedValue(null);

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(makeJob({ attachmentId: 'att-999', tenantId: 'tenant-1', category: 'image' }));

    // Should not attempt download, process, or update
    expect(storageProvider.download).not.toHaveBeenCalled();
    expect(imageProcessor.process).not.toHaveBeenCalled();
    expect(documentParser.parse).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(indexQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // DOWNLOAD FAILURE: Marks as failed
  // ---------------------------------------------------------------------------

  it('download failure: marks failed with error', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    (storageProvider.download as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('S3 download failed: access denied'),
    );

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'image' }));

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processingStatus: 'failed',
          processingError: 'S3 download failed: access denied',
        },
      },
    );

    // Should NOT enqueue index job
    expect(indexQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // IMAGE PROCESSOR FAILURE: Marks as failed
  // ---------------------------------------------------------------------------

  it('ImageProcessor failure: marks failed with error', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    (imageProcessor.process as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('sharp: Input buffer contains unsupported image format'),
    );

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', category: 'image' }));

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processingStatus: 'failed',
          processingError: 'sharp: Input buffer contains unsupported image format',
        },
      },
    );

    // Should NOT upload or enqueue
    expect(storageProvider.upload).not.toHaveBeenCalled();
    expect(indexQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // TENANT ISOLATION: All DB operations use tenantId
  // ---------------------------------------------------------------------------

  it('uses tenant-scoped queries for all DB operations', async () => {
    const attachment = makeAttachmentDoc({ tenantId: 'tenant-42' });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createProcessWorker({
      storageProvider,
      imageProcessor,
      documentParser,
      transcriptionProvider,
      videoProcessor,
      indexQueue,
    });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-42', category: 'image' }));

    // findOne includes tenantId
    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-42' });

    // findOneAndUpdate includes tenantId
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-42' },
      expect.any(Object),
    );

    // Enqueued job carries tenantId
    expect(indexQueue.add).toHaveBeenCalledWith('attachment-index', {
      attachmentId: 'att-001',
      tenantId: 'tenant-42',
    });
  });
});

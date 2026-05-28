import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import crypto from 'crypto';
import type { AttachmentInput, AttachmentConfig, StorageProvider } from '@agent-platform/shared';

// =============================================================================
// MOCK: Mongoose Attachment model
// =============================================================================

const mockFindOne = vi.fn();
const mockFind = vi.fn();
const mockCreate = vi.fn();
const mockDeleteOne = vi.fn();
const mockDeleteMany = vi.fn();

vi.mock('@agent-platform/database', () => ({
  Attachment: {
    findOne: (...args: unknown[]) => {
      const result = mockFindOne(...args);
      // Return a thenable with .lean() chaining
      return { lean: () => result };
    },
    find: (...args: unknown[]) => {
      const result = mockFind(...args);
      return {
        sort: () => ({
          limit: () => ({
            lean: () => result,
            skip: () => ({
              lean: () => result,
            }),
          }),
        }),
        lean: () => result,
      };
    },
    create: mockCreate,
    deleteOne: mockDeleteOne,
    deleteMany: mockDeleteMany,
  },
}));

// =============================================================================
// MOCK: mimeToCategory
// =============================================================================

vi.mock('../security/mime-validator.js', () => ({
  mimeToCategory: (mime: string): string | null => {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/pdf' || mime.startsWith('text/')) return 'document';
    return null;
  },
}));

// =============================================================================
// HELPERS
// =============================================================================

function makeStorageProvider(): StorageProvider {
  return {
    name: 'test-provider',
    upload: vi.fn().mockResolvedValue({ storageKey: 'mocked-key', etag: 'mocked-etag' }),
    download: vi.fn(),
    getSignedUrl: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    exists: vi.fn(),
    copy: vi.fn(),
    healthCheck: vi.fn(),
  };
}

function makeScanQueue() {
  return { add: vi.fn().mockResolvedValue(undefined) };
}

function makeConfig(overrides?: Partial<AttachmentConfig>): AttachmentConfig {
  return {
    enabled: true,
    maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB
    maxAttachmentsPerMessage: 5,
    maxAttachmentsPerSession: 50,
    maxTotalStorageBytesPerTenant: 1024 * 1024 * 1024, // 1 GB
    allowedCategories: ['image', 'document', 'audio', 'video'],
    retentionDays: { image: 90, document: 90, audio: 90, video: 90 },
    allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'audio/mpeg'],
    quotas: { maxUploadsPerMinute: 60, maxConcurrentProcessingJobs: 10 },
    ...overrides,
  };
}

function makeInput(overrides?: Partial<AttachmentInput>): AttachmentInput {
  const content = 'test file content';
  return {
    source: {
      type: 'stream',
      stream: Readable.from([Buffer.from(content)]),
      filename: 'test-file.png',
      mimeType: 'image/png',
      sizeBytes: Buffer.byteLength(content),
    },
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    channel: 'web',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('AttachmentService', () => {
  let storageProvider: ReturnType<typeof makeStorageProvider>;
  let scanQueue: ReturnType<typeof makeScanQueue>;

  // Import lazily so mocks are in place
  let AttachmentService: typeof import('../services/multimodal-service.js').AttachmentService;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default mock returns
    mockFindOne.mockResolvedValue(null);
    mockFind.mockResolvedValue([]);
    mockCreate.mockResolvedValue({});
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mockDeleteMany.mockResolvedValue({ deletedCount: 0 });

    storageProvider = makeStorageProvider();
    scanQueue = makeScanQueue();

    const mod = await import('../services/multimodal-service.js');
    AttachmentService = mod.AttachmentService;
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it('validates and stores an attachment, returns attachmentId', async () => {
    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    const result = await service.upload(makeInput(), makeConfig());

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.attachmentId).toBeDefined();
    expect(result.status).toBe('accepted');

    // Storage upload was called
    expect(storageProvider.upload).toHaveBeenCalledOnce();

    // Attachment record was created
    expect(mockCreate).toHaveBeenCalledOnce();
    const created = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(created.tenantId).toBe('tenant-1');
    expect(created.projectId).toBe('project-1');
    expect(created.sessionId).toBe('session-1');
    expect(created.category).toBe('image');
    expect(created.mimeType).toBe('image/png');
    expect(created.scanStatus).toBe('pending');
    expect(created.storageBucket).toBe('test-bucket');
    expect(created.storageProvider).toBe('test-provider');

    // Scan job was enqueued
    expect(scanQueue.add).toHaveBeenCalledWith('scan', {
      attachmentId: result.attachmentId,
      tenantId: 'tenant-1',
    });
  });

  // ---------------------------------------------------------------------------
  // Validation: file too large
  // ---------------------------------------------------------------------------

  it('rejects files exceeding max size', async () => {
    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    // Create a buffer that exceeds the 100-byte config limit
    const bigContent = 'x'.repeat(200);
    const input = makeInput({
      source: {
        type: 'stream',
        stream: Readable.from([Buffer.from(bigContent)]),
        filename: 'big.png',
        mimeType: 'image/png',
        sizeBytes: bigContent.length,
      },
    });

    const result = await service.upload(input, makeConfig({ maxFileSizeBytes: 100 }));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('FILE_TOO_LARGE');
    expect(storageProvider.upload).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Validation: disallowed MIME type
  // ---------------------------------------------------------------------------

  it('rejects files with disallowed MIME types', async () => {
    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    const input = makeInput({
      source: {
        type: 'stream',
        stream: Readable.from([Buffer.from('data')]),
        filename: 'malware.exe',
        mimeType: 'application/x-executable',
        sizeBytes: 4,
      },
    });

    const result = await service.upload(input, makeConfig());

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('MIME_TYPE_NOT_ALLOWED');
  });

  it('allows any MIME type when allowedMimeTypes is empty', async () => {
    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    const input = makeInput({
      source: {
        type: 'stream',
        stream: Readable.from([Buffer.from('# Notes')]),
        filename: 'notes.md',
        mimeType: 'text/markdown',
        sizeBytes: 7,
      },
    });

    const result = await service.upload(input, makeConfig({ allowedMimeTypes: [] }));

    expect(result.success).toBe(true);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });

  it('allows MIME types through wildcard entries', async () => {
    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    const input = makeInput({
      source: {
        type: 'stream',
        stream: Readable.from([Buffer.from('%PDF-1.4')]),
        filename: 'brief.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 8,
      },
    });

    const result = await service.upload(input, makeConfig({ allowedMimeTypes: ['application/*'] }));

    expect(result.success).toBe(true);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // Validation: attachments disabled
  // ---------------------------------------------------------------------------

  it('rejects when attachments disabled', async () => {
    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    const result = await service.upload(makeInput(), makeConfig({ enabled: false }));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('ATTACHMENTS_DISABLED');
  });

  // ---------------------------------------------------------------------------
  // Deduplication
  // ---------------------------------------------------------------------------

  it('deduplicates by content hash within tenant', async () => {
    const content = 'duplicate content';
    const contentHash = crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');

    // Simulate an existing attachment with same content hash
    mockFind.mockResolvedValue([
      {
        _id: 'existing-attachment-id',
        tenantId: 'tenant-1',
        contentHash,
        storageKey: 'tenant-1/session-1/existing/original',
      },
    ]);
    storageProvider.exists = vi.fn().mockResolvedValue(true);

    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    const input = makeInput({
      source: {
        type: 'stream',
        stream: Readable.from([Buffer.from(content)]),
        filename: 'dup.png',
        mimeType: 'image/png',
        sizeBytes: Buffer.byteLength(content),
      },
    });

    const result = await service.upload(input, makeConfig());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attachmentId).toBe('existing-attachment-id');

    // Should NOT upload or create a new record
    expect(storageProvider.upload).not.toHaveBeenCalled();
    expect(storageProvider.exists).toHaveBeenCalledWith('tenant-1/session-1/existing/original');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('ignores stale dedupe candidates whose storage objects are missing', async () => {
    const content = 'duplicate content';
    const contentHash = crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');

    mockFind.mockResolvedValue([
      {
        _id: 'stale-attachment-id',
        tenantId: 'tenant-1',
        contentHash,
        storageKey: 'tenant-1/session-1/stale/original',
      },
    ]);
    storageProvider.exists = vi.fn().mockResolvedValue(false);

    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    const input = makeInput({
      source: {
        type: 'stream',
        stream: Readable.from([Buffer.from(content)]),
        filename: 'stale-dedupe.png',
        mimeType: 'image/png',
        sizeBytes: Buffer.byteLength(content),
      },
    });

    const result = await service.upload(input, makeConfig());

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.attachmentId).not.toBe('stale-attachment-id');
    expect(storageProvider.exists).toHaveBeenCalledWith('tenant-1/session-1/stale/original');
    expect(storageProvider.upload).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // Storage key format (no user-supplied filename)
  // ---------------------------------------------------------------------------

  it('generates server-side storage key (never uses user-supplied filename)', async () => {
    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    const input = makeInput({
      source: {
        type: 'stream',
        stream: Readable.from([Buffer.from('data')]),
        filename: '../../etc/passwd',
        mimeType: 'image/png',
        sizeBytes: 4,
      },
    });

    const result = await service.upload(input, makeConfig());
    expect(result.success).toBe(true);

    // Verify the storage key passed to upload
    const uploadCall = (storageProvider.upload as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      key: string;
      metadata: Record<string, string>;
    };
    const key = uploadCall.key;

    // Key must NOT contain user-supplied filename
    expect(key).not.toContain('passwd');
    expect(key).not.toContain('..');

    // Key must follow the pattern: {tenantId}/{projectId}/{sessionId}/{attachmentId}/original
    const segments = key.split('/');
    expect(segments).toHaveLength(5);
    expect(segments[0]).toBe('tenant-1');
    expect(segments[1]).toBe('project-1');
    expect(segments[2]).toBe('session-1');
    expect(segments[4]).toBe('original');

    // The original filename should be stored in metadata, not in the key
    expect(uploadCall.metadata.originalFilename).toBe('../../etc/passwd');
  });

  // ---------------------------------------------------------------------------
  // getAttachment: tenant-scoped
  // ---------------------------------------------------------------------------

  it('gets attachment by ID (tenant-scoped)', async () => {
    const fakeAttachment = {
      _id: 'att-1',
      tenantId: 'tenant-1',
      originalFilename: 'photo.png',
    };
    mockFindOne.mockResolvedValue(fakeAttachment);

    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    const result = await service.getAttachment('att-1', 'tenant-1');
    expect(result).toEqual(fakeAttachment);

    // Verify the query includes both _id AND tenantId
    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-1', tenantId: 'tenant-1' });
  });

  // ---------------------------------------------------------------------------
  // getAttachment: cross-tenant returns null
  // ---------------------------------------------------------------------------

  it('returns null for cross-tenant get', async () => {
    mockFindOne.mockResolvedValue(null);

    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    const result = await service.getAttachment('att-1', 'tenant-2');
    expect(result).toBeNull();
    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-1', tenantId: 'tenant-2' });
  });

  // ---------------------------------------------------------------------------
  // listBySession: tenant-scoped
  // ---------------------------------------------------------------------------

  it('lists attachments by session (tenant-scoped)', async () => {
    const fakeList = [
      { _id: 'att-1', sessionId: 'session-1', tenantId: 'tenant-1' },
      { _id: 'att-2', sessionId: 'session-1', tenantId: 'tenant-1' },
    ];
    mockFind.mockResolvedValue(fakeList);

    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    const result = await service.listBySession('session-1', 'tenant-1', {
      limit: 10,
      offset: 0,
    });

    expect(result).toEqual(fakeList);
    expect(mockFind).toHaveBeenCalledWith({ sessionId: 'session-1', tenantId: 'tenant-1' });
  });

  // ---------------------------------------------------------------------------
  // deleteAttachment: deletes storage + record
  // ---------------------------------------------------------------------------

  it('deletes attachment and storage files', async () => {
    const fakeAttachment = {
      _id: 'att-1',
      tenantId: 'tenant-1',
      storageKey: 'tenant-1/project-1/session-1/att-1/original',
      resizedStorageKey: 'tenant-1/project-1/session-1/att-1/resized',
      thumbnailStorageKey: 'tenant-1/project-1/session-1/att-1/thumbnail',
    };
    mockFindOne.mockResolvedValue(fakeAttachment);

    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    await service.deleteAttachment('att-1', 'tenant-1');

    // Should delete original, resized, and thumbnail
    expect(storageProvider.delete).toHaveBeenCalledTimes(3);
    expect(storageProvider.delete).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-1/original',
    );
    expect(storageProvider.delete).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-1/resized',
    );
    expect(storageProvider.delete).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-1/thumbnail',
    );

    // Should delete the DB record with tenant scope
    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: 'att-1', tenantId: 'tenant-1' });
  });

  // ---------------------------------------------------------------------------
  // deleteBySession: bulk delete
  // ---------------------------------------------------------------------------

  it('deletes all attachments for a session', async () => {
    mockFind.mockResolvedValue([
      {
        _id: 'att-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        storageKey: 'tenant-1/project-1/session-1/att-1/original',
      },
      {
        _id: 'att-2',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        storageKey: 'tenant-1/project-1/session-1/att-2/original',
      },
    ]);

    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    await service.deleteBySession('session-1', 'tenant-1');

    // Should delete via prefix
    expect(storageProvider.deleteMany).toHaveBeenCalledWith('tenant-1/project-1/session-1/');

    // Should delete all records
    expect(mockDeleteMany).toHaveBeenCalledWith({
      sessionId: 'session-1',
      tenantId: 'tenant-1',
    });
  });

  // ---------------------------------------------------------------------------
  // Validation: disallowed category
  // ---------------------------------------------------------------------------

  it('rejects disallowed category', async () => {
    const service = new AttachmentService({
      storageProvider,
      scanQueue,
      storageBucket: 'test-bucket',
    });

    // audio/mpeg is in allowedMimeTypes but category 'audio' is excluded
    const input = makeInput({
      source: {
        type: 'stream',
        stream: Readable.from([Buffer.from('audio data')]),
        filename: 'song.mp3',
        mimeType: 'audio/mpeg',
        sizeBytes: 10,
      },
    });

    const result = await service.upload(
      input,
      makeConfig({ allowedCategories: ['image', 'document'] }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('CATEGORY_NOT_ALLOWED');
    expect(storageProvider.upload).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'stream';

// =============================================================================
// AWS SDK Mocks — vi.hoisted() ensures these are available inside vi.mock()
// =============================================================================

const { mockSend, mockGetSignedUrl, makeMockCommand } = vi.hoisted(() => {
  const _mockSend = vi.fn();
  const _mockGetSignedUrl = vi.fn();

  /**
   * Create a mock Command class that stores its input and can be used with `new`.
   * The constructor is a vi.fn() so we can assert on call arguments.
   */
  function _makeMockCommand(type: string) {
    return vi.fn().mockImplementation(function (this: any, input: unknown) {
      this._type = type;
      this.input = input;
    });
  }

  return {
    mockSend: _mockSend,
    mockGetSignedUrl: _mockGetSignedUrl,
    makeMockCommand: _makeMockCommand,
  };
});

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    constructor(public config: Record<string, unknown>) {}
    send = mockSend;
  }

  return {
    S3Client: MockS3Client,
    PutObjectCommand: makeMockCommand('PutObject'),
    GetObjectCommand: makeMockCommand('GetObject'),
    DeleteObjectCommand: makeMockCommand('DeleteObject'),
    DeleteObjectsCommand: makeMockCommand('DeleteObjects'),
    HeadObjectCommand: makeMockCommand('HeadObject'),
    HeadBucketCommand: makeMockCommand('HeadBucket'),
    CopyObjectCommand: makeMockCommand('CopyObject'),
    ListObjectsV2Command: makeMockCommand('ListObjectsV2'),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

// =============================================================================
// Import the system under test AFTER mocks are registered
// =============================================================================

import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

import { S3StorageProvider } from '../s3-storage.js';

// =============================================================================
// Helpers
// =============================================================================

const TEST_BUCKET = 'my-test-bucket';
const TEST_REGION = 'us-east-1';

function createProvider(
  overrides?: Partial<ConstructorParameters<typeof S3StorageProvider>[0]>,
): S3StorageProvider {
  return new S3StorageProvider({
    bucket: TEST_BUCKET,
    region: TEST_REGION,
    ...overrides,
  });
}

function makeReadable(content: string): Readable {
  return Readable.from([Buffer.from(content)]);
}

// =============================================================================
// Tests
// =============================================================================

describe('S3StorageProvider', () => {
  let provider: S3StorageProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createProvider();
  });

  // ---------------------------------------------------------------------------
  // name
  // ---------------------------------------------------------------------------

  it('has name "s3"', () => {
    expect(provider.name).toBe('s3');
  });

  // ---------------------------------------------------------------------------
  // upload
  // ---------------------------------------------------------------------------

  describe('upload()', () => {
    it('calls PutObjectCommand with correct params and default AES256 encryption', async () => {
      mockSend.mockResolvedValueOnce({ ETag: '"abc123"' });

      const result = await provider.upload({
        key: 'tenant-1/proj-1/file.png',
        body: makeReadable('image-data'),
        contentType: 'image/png',
        sizeBytes: 10,
        metadata: { originalName: 'photo.png' },
      });

      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: TEST_BUCKET,
          Key: 'tenant-1/proj-1/file.png',
          ContentType: 'image/png',
          ContentLength: 10,
          Metadata: { originalName: 'photo.png' },
          ServerSideEncryption: 'AES256',
        }),
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(result.storageKey).toBe('tenant-1/proj-1/file.png');
      expect(result.etag).toBe('abc123');
    });

    it('uses SSE-KMS when encryption.keyId is provided', async () => {
      mockSend.mockResolvedValueOnce({ ETag: '"kms-etag"' });

      await provider.upload({
        key: 'enc/file',
        body: makeReadable('secret'),
        contentType: 'application/octet-stream',
        sizeBytes: 6,
        metadata: {},
        encryption: { algorithm: 'aws:kms', keyId: 'arn:aws:kms:us-east-1:111:key/abc' },
      });

      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: 'arn:aws:kms:us-east-1:111:key/abc',
        }),
      );
    });

    it('strips surrounding quotes from ETag', async () => {
      mockSend.mockResolvedValueOnce({ ETag: '"quoted-etag-value"' });

      const result = await provider.upload({
        key: 'f',
        body: makeReadable('x'),
        contentType: 'text/plain',
        sizeBytes: 1,
        metadata: {},
      });

      expect(result.etag).toBe('quoted-etag-value');
    });
  });

  // ---------------------------------------------------------------------------
  // download
  // ---------------------------------------------------------------------------

  describe('download()', () => {
    it('calls GetObjectCommand and returns stream + metadata', async () => {
      const fakeBody = makeReadable('file-content');
      mockSend.mockResolvedValueOnce({
        Body: fakeBody,
        ContentType: 'text/plain',
        ContentLength: 12,
      });

      const result = await provider.download('tenant-1/file.txt');

      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: TEST_BUCKET,
        Key: 'tenant-1/file.txt',
      });
      expect(result.body).toBe(fakeBody);
      expect(result.contentType).toBe('text/plain');
      expect(result.sizeBytes).toBe(12);
    });

    it('defaults contentType and sizeBytes when S3 response omits them', async () => {
      mockSend.mockResolvedValueOnce({
        Body: makeReadable('data'),
      });

      const result = await provider.download('key');
      expect(result.contentType).toBe('application/octet-stream');
      expect(result.sizeBytes).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getSignedUrl
  // ---------------------------------------------------------------------------

  describe('getSignedUrl()', () => {
    it('calls presigner getSignedUrl with correct expiry', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://s3.example.com/signed');

      const url = await provider.getSignedUrl('tenant/file.pdf', {
        expiresInSeconds: 3600,
      });

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          _type: 'GetObject',
          input: expect.objectContaining({
            Bucket: TEST_BUCKET,
            Key: 'tenant/file.pdf',
          }),
        }),
        { expiresIn: 3600 },
      );
      expect(url).toBe('https://s3.example.com/signed');
    });

    it('clamps expiresInSeconds to 7-day maximum', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://s3.example.com/clamped');

      const EIGHT_DAYS_IN_SECONDS = 8 * 24 * 60 * 60;
      const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;

      await provider.getSignedUrl('key', {
        expiresInSeconds: EIGHT_DAYS_IN_SECONDS,
      });

      expect(mockGetSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        expiresIn: SEVEN_DAYS_IN_SECONDS,
      });
    });

    it('passes ResponseContentDisposition for attachment with filename', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://s3.example.com/dl');

      await provider.getSignedUrl('key', {
        expiresInSeconds: 60,
        disposition: 'attachment',
        filename: 'report.pdf',
      });

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            ResponseContentDisposition: 'attachment; filename="report.pdf"',
          }),
        }),
        expect.anything(),
      );
    });

    it('passes ResponseContentDisposition for inline', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://s3.example.com/inline');

      await provider.getSignedUrl('key', {
        expiresInSeconds: 60,
        disposition: 'inline',
      });

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            ResponseContentDisposition: 'inline',
          }),
        }),
        expect.anything(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe('delete()', () => {
    it('calls DeleteObjectCommand', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete('tenant/obj-key');

      expect(DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: TEST_BUCKET,
        Key: 'tenant/obj-key',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteMany
  // ---------------------------------------------------------------------------

  describe('deleteMany()', () => {
    it('paginates ListObjectsV2 then batch-deletes with DeleteObjectsCommand', async () => {
      // First ListObjectsV2 call returns 2 objects + a continuation token
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/a' }, { Key: 'prefix/b' }],
        IsTruncated: true,
        NextContinuationToken: 'token-1',
      });
      // Second ListObjectsV2 call returns 1 object, no continuation
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/c' }],
        IsTruncated: false,
      });
      // DeleteObjectsCommand response
      mockSend.mockResolvedValueOnce({
        Deleted: [{ Key: 'prefix/a' }, { Key: 'prefix/b' }, { Key: 'prefix/c' }],
      });

      const result = await provider.deleteMany('prefix/');

      expect(ListObjectsV2Command).toHaveBeenCalledTimes(2);
      expect(DeleteObjectsCommand).toHaveBeenCalledWith({
        Bucket: TEST_BUCKET,
        Delete: {
          Objects: [{ Key: 'prefix/a' }, { Key: 'prefix/b' }, { Key: 'prefix/c' }],
          Quiet: true,
        },
      });
      expect(result.deletedCount).toBe(3);
    });

    it('returns zero when no objects match the prefix', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: undefined,
        IsTruncated: false,
      });

      const result = await provider.deleteMany('empty-prefix/');
      expect(result.deletedCount).toBe(0);
      expect(DeleteObjectsCommand).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // exists
  // ---------------------------------------------------------------------------

  describe('exists()', () => {
    it('returns true when HeadObjectCommand succeeds', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await provider.exists('tenant/obj');

      expect(HeadObjectCommand).toHaveBeenCalledWith({
        Bucket: TEST_BUCKET,
        Key: 'tenant/obj',
      });
      expect(result).toBe(true);
    });

    it('returns false when HeadObjectCommand throws NotFound', async () => {
      const notFoundError = new Error('NotFound');
      notFoundError.name = 'NotFound';
      mockSend.mockRejectedValueOnce(notFoundError);

      const result = await provider.exists('missing/key');
      expect(result).toBe(false);
    });

    it('returns false when HeadObjectCommand throws 404', async () => {
      const error: Error & { $metadata?: { httpStatusCode?: number } } = new Error('Not Found');
      error.name = 'SomeS3Error';
      error.$metadata = { httpStatusCode: 404 };
      mockSend.mockRejectedValueOnce(error);

      const result = await provider.exists('another/missing');
      expect(result).toBe(false);
    });

    it('re-throws non-NotFound errors', async () => {
      const accessDenied = new Error('Access Denied');
      accessDenied.name = 'AccessDenied';
      mockSend.mockRejectedValueOnce(accessDenied);

      await expect(provider.exists('secret/key')).rejects.toThrow('Access Denied');
    });
  });

  // ---------------------------------------------------------------------------
  // healthCheck
  // ---------------------------------------------------------------------------

  describe('healthCheck()', () => {
    it('calls HeadBucketCommand and returns ok=true with latency', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await provider.healthCheck();

      expect(HeadBucketCommand).toHaveBeenCalledWith({ Bucket: TEST_BUCKET });
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns ok=false when HeadBucketCommand fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('bucket gone'));

      const result = await provider.healthCheck();
      expect(result.ok).toBe(false);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // copy
  // ---------------------------------------------------------------------------

  describe('copy()', () => {
    it('calls CopyObjectCommand with correct source and destination', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.copy('src/original.png', 'dest/copied.png');

      expect(CopyObjectCommand).toHaveBeenCalledWith({
        Bucket: TEST_BUCKET,
        CopySource: `${TEST_BUCKET}/src/original.png`,
        Key: 'dest/copied.png',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Constructor configuration
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('accepts custom endpoint for S3-compatible storage', () => {
      const p = createProvider({ endpoint: 'http://localhost:9000' });
      expect(p.name).toBe('s3');
    });

    it('accepts explicit credentials', () => {
      const p = createProvider({
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'secret_test',
      });
      expect(p.name).toBe('s3');
    });
  });
});

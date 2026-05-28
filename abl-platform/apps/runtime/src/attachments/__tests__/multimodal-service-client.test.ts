/**
 * MultimodalServiceClient Tests
 *
 * Verifies the HTTP client for the multimodal-service internal API.
 * All fetch calls are mocked via vi.spyOn(globalThis, 'fetch').
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
import { MultimodalServiceClient } from '../multimodal-service-client.js';
import type { IAttachment } from '@agent-platform/database';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = 'http://test-multimodal:3006';
const TENANT_ID = 'tenant-001';
const PROJECT_ID = 'proj-001';
const SESSION_ID = 'sess-001';

function createClient(): MultimodalServiceClient {
  return new MultimodalServiceClient(BASE_URL);
}

function mockStream(content = 'file-content'): Readable {
  return Readable.from([Buffer.from(content)]);
}

function mockAttachment(overrides: Partial<IAttachment> = {}): IAttachment {
  return {
    _id: 'att-1',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    messageId: null,
    originalFilename: 'photo.jpg',
    mimeType: 'image/jpeg',
    detectedMimeType: null,
    category: 'image',
    sizeBytes: 1024,
    contentHash: null,
    storageProvider: 's3',
    storageKey: 'uploads/att-1.jpg',
    storageBucket: 'attachments',
    encrypted: false,
    encryptionKeyVersion: 0,
    processingMode: 'full',
    scanStatus: 'pending',
    scanEngine: null,
    scannedAt: null,
    hasPII: false,
    piiDetections: [],
    exifStripped: false,
    processingStatus: 'pending',
    processedContent: null,
    processedContentHash: null,
    processingError: null,
    processingEngine: null,
    processedAt: null,
    resizedStorageKey: null,
    resizedSizeBytes: null,
    thumbnailStorageKey: null,
    imageDescription: null,
    imageDescriptionModel: null,
    searchIndexId: null,
    searchDocumentId: null,
    embeddingStatus: 'pending',
    embeddedAt: null,
    retryCount: 0,
    expiresAt: '2026-04-01T00:00:00.000Z' as unknown as Date,
    // Dates are ISO strings after JSON round-trip (Response -> res.json())
    createdAt: '2026-01-01T00:00:00.000Z' as unknown as Date,
    updatedAt: '2026-01-01T00:00:00.000Z' as unknown as Date,
    _v: 1,
    ...overrides,
  } as IAttachment;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MultimodalServiceClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constructor ──────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('uses provided baseUrl', () => {
      const client = new MultimodalServiceClient('http://custom:9000');
      // Verify by making a call and checking the URL
      fetchSpy.mockResolvedValue(jsonResponse({ success: true, data: { attachments: [] } }));
      client.listBySession('s1', 't1');
      // The fetch call should use the custom URL
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('http://custom:9000'),
        expect.anything(),
      );
    });

    it('falls back to env variable', () => {
      const orig = process.env.MULTIMODAL_SERVICE_URL;
      process.env.MULTIMODAL_SERVICE_URL = 'http://env-url:4000';
      try {
        const client = new MultimodalServiceClient();
        fetchSpy.mockResolvedValue(jsonResponse({ success: true, data: { attachments: [] } }));
        client.listBySession('s1', 't1');
        expect(fetchSpy).toHaveBeenCalledWith(
          expect.stringContaining('http://env-url:4000'),
          expect.anything(),
        );
      } finally {
        if (orig === undefined) {
          delete process.env.MULTIMODAL_SERVICE_URL;
        } else {
          process.env.MULTIMODAL_SERVICE_URL = orig;
        }
      }
    });

    it('falls back to default URL', () => {
      const orig = process.env.MULTIMODAL_SERVICE_URL;
      delete process.env.MULTIMODAL_SERVICE_URL;
      try {
        const client = new MultimodalServiceClient();
        fetchSpy.mockResolvedValue(jsonResponse({ success: true, data: { attachments: [] } }));
        client.listBySession('s1', 't1');
        expect(fetchSpy).toHaveBeenCalledWith(
          expect.stringContaining('http://multimodal-service:3006'),
          expect.anything(),
        );
      } finally {
        if (orig !== undefined) {
          process.env.MULTIMODAL_SERVICE_URL = orig;
        }
      }
    });
  });

  // ── Upload ───────────────────────────────────────────────────────────────

  describe('upload', () => {
    it('sends multipart POST and returns attachmentId', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        jsonResponse({ success: true, data: { attachmentId: 'att-1', status: 'accepted' } }, 201),
      );

      const result = await client.upload({
        stream: mockStream(),
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        messageId: 'msg-1',
        channel: 'web',
      });

      expect(result).toEqual({
        success: true,
        attachmentId: 'att-1',
        status: 'accepted',
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/internal/attachments`);
      expect(opts.method).toBe('POST');
      expect(opts.headers['X-Tenant-Id']).toBe(TENANT_ID);
      expect(opts.headers['X-Project-Id']).toBe(PROJECT_ID);
      expect(opts.body).toBeInstanceOf(FormData);
    });

    it('includes optional fields in form data', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        jsonResponse({ success: true, data: { attachmentId: 'att-2', status: 'accepted' } }, 201),
      );

      const config = {
        enabled: true,
        maxFileSizeBytes: 10_000_000,
        maxAttachmentsPerMessage: 5,
        maxAttachmentsPerSession: 20,
        maxTotalStorageBytesPerTenant: 1_000_000_000,
        allowedCategories: ['image' as const],
        retentionDays: { image: 30, document: 90, audio: 30, video: 30 },
        allowedMimeTypes: ['image/jpeg'],
        quotas: { maxUploadsPerMinute: 10, maxConcurrentProcessingJobs: 5 },
      };

      await client.upload({
        stream: mockStream(),
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 512,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        channel: 'web',
        config,
      });

      const formData = fetchSpy.mock.calls[0][1].body as FormData;
      expect(formData.get('sessionId')).toBe(SESSION_ID);
      expect(formData.get('channel')).toBe('web');
      expect(formData.get('sizeBytes')).toBe('512');
      expect(formData.get('config')).toBe(JSON.stringify(config));
    });

    it('returns error on failure response', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        jsonResponse(
          {
            success: false,
            error: { code: 'FILE_TOO_LARGE', message: 'Max size exceeded' },
          },
          400,
        ),
      );

      const result = await client.upload({
        stream: mockStream(),
        filename: 'big.zip',
        mimeType: 'application/zip',
        sizeBytes: 999_999_999,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      });

      expect(result).toEqual({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: 'Max size exceeded' },
      });
    });

    it('returns structured error on network failure', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      const result = await client.upload({
        stream: mockStream(),
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      });

      expect(result).toEqual({
        success: false,
        error: { code: 'NETWORK_ERROR', message: 'fetch failed' },
      });
    });

    it('enforces maxSizeBytes while buffering the upload stream', async () => {
      const client = createClient();

      const result = await client.upload({
        stream: Readable.from([Buffer.from('12345'), Buffer.from('67890')]),
        filename: 'too-large.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 0, // unknown from source
        maxSizeBytes: 8,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NETWORK_ERROR');
        expect(result.error.message).toContain('exceeds max size');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns fallback error when response has no error field', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(jsonResponse({ success: false }, 500));

      const result = await client.upload({
        stream: mockStream(),
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      });

      expect(result).toEqual({
        success: false,
        error: { code: 'UPLOAD_FAILED', message: 'Upload failed with HTTP 500' },
      });
    });
  });

  // ── Get Attachment ───────────────────────────────────────────────────────

  describe('getAttachment', () => {
    it('returns attachment metadata', async () => {
      const client = createClient();
      const att = mockAttachment();
      fetchSpy.mockResolvedValue(jsonResponse({ success: true, data: { attachment: att } }));

      const result = await client.getAttachment('att-1', TENANT_ID);
      expect(result).toEqual(att);

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/internal/attachments/att-1`);
      expect(opts.method).toBe('GET');
      expect(opts.headers['X-Tenant-Id']).toBe(TENANT_ID);
    });

    it('returns null on 404', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(emptyResponse(404));

      const result = await client.getAttachment('nonexistent', TENANT_ID);
      expect(result).toBeNull();
    });

    it('returns null on server error', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(jsonResponse({ success: false }, 500));

      const result = await client.getAttachment('att-1', TENANT_ID);
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      const result = await client.getAttachment('att-1', TENANT_ID);
      expect(result).toBeNull();
    });
  });

  // ── List by Session ──────────────────────────────────────────────────────

  describe('listBySession', () => {
    it('returns array of attachments', async () => {
      const client = createClient();
      const attachments = [mockAttachment({ _id: 'att-1' }), mockAttachment({ _id: 'att-2' })];
      fetchSpy.mockResolvedValue(jsonResponse({ success: true, data: { attachments } }));

      const result = await client.listBySession(SESSION_ID, TENANT_ID);
      expect(result).toHaveLength(2);
      expect(result[0]._id).toBe('att-1');
      expect(result[1]._id).toBe('att-2');

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/internal/attachments/session/${SESSION_ID}`);
      expect(opts.headers['X-Tenant-Id']).toBe(TENANT_ID);
    });

    it('passes pagination params as query string', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(jsonResponse({ success: true, data: { attachments: [] } }));

      await client.listBySession(SESSION_ID, TENANT_ID, { limit: 10, offset: 20 });

      const [url] = fetchSpy.mock.calls[0];
      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.get('limit')).toBe('10');
      expect(parsedUrl.searchParams.get('offset')).toBe('20');
    });

    it('omits query string when no pagination opts', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(jsonResponse({ success: true, data: { attachments: [] } }));

      await client.listBySession(SESSION_ID, TENANT_ID);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).not.toContain('?');
    });

    it('returns empty array on server error', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(jsonResponse({ success: false }, 500));

      const result = await client.listBySession(SESSION_ID, TENANT_ID);
      expect(result).toEqual([]);
    });

    it('returns empty array on network error', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      const result = await client.listBySession(SESSION_ID, TENANT_ID);
      expect(result).toEqual([]);
    });
  });

  // ── Get Download URL ─────────────────────────────────────────────────────

  describe('getDownloadUrl', () => {
    it('returns presigned URL', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        jsonResponse({
          success: true,
          data: { url: 'https://cdn.example.com/att-1?sig=abc', expiresInSeconds: 3600 },
        }),
      );

      const result = await client.getDownloadUrl('att-1', TENANT_ID);
      expect(result).toBe('https://cdn.example.com/att-1?sig=abc');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/internal/attachments/att-1/url`);
    });

    it('passes disposition and expiresIn query params', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        jsonResponse({
          success: true,
          data: { url: 'https://cdn.example.com/att-1', expiresInSeconds: 600 },
        }),
      );

      await client.getDownloadUrl('att-1', TENANT_ID, {
        disposition: 'attachment',
        expiresIn: 600,
      });

      const [url] = fetchSpy.mock.calls[0];
      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.get('disposition')).toBe('attachment');
      expect(parsedUrl.searchParams.get('expiresIn')).toBe('600');
    });

    it('returns null on 404', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(emptyResponse(404));

      const result = await client.getDownloadUrl('nonexistent', TENANT_ID);
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      const result = await client.getDownloadUrl('att-1', TENANT_ID);
      expect(result).toBeNull();
    });
  });

  // ── Download Content ─────────────────────────────────────────────────────

  describe('downloadAttachmentContent', () => {
    it('returns attachment bytes and response metadata', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        new Response(Buffer.from('image-bytes'), {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': '11',
          },
        }),
      );

      const result = await client.downloadAttachmentContent('att-1', TENANT_ID);

      expect(result).toEqual({
        content: Buffer.from('image-bytes'),
        contentType: 'image/png',
        sizeBytes: 11,
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/internal/attachments/att-1/content`);
      expect(opts.method).toBe('GET');
      expect(opts.headers['X-Tenant-Id']).toBe(TENANT_ID);
    });

    it('returns null on 404', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(emptyResponse(404));

      const result = await client.downloadAttachmentContent('nonexistent', TENANT_ID);
      expect(result).toBeNull();
    });

    it('falls back to buffer length when content-length is missing', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        new Response(Buffer.from('bytes'), {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
          },
        }),
      );

      const result = await client.downloadAttachmentContent('att-1', TENANT_ID);
      expect(result).toEqual({
        content: Buffer.from('bytes'),
        contentType: 'image/png',
        sizeBytes: 5,
      });
    });

    it('returns null on network error', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      const result = await client.downloadAttachmentContent('att-1', TENANT_ID);
      expect(result).toBeNull();
    });
  });

  // ── Get Status ───────────────────────────────────────────────────────────

  describe('getStatus', () => {
    it('returns status fields', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        jsonResponse({
          success: true,
          data: {
            scanStatus: 'clean',
            processingStatus: 'completed',
            embeddingStatus: 'pending',
          },
        }),
      );

      const result = await client.getStatus('att-1', TENANT_ID);
      expect(result).toEqual({
        scanStatus: 'clean',
        processingStatus: 'completed',
        embeddingStatus: 'pending',
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/internal/attachments/att-1/status`);
    });

    it('returns null on 404', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(emptyResponse(404));

      const result = await client.getStatus('nonexistent', TENANT_ID);
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      const result = await client.getStatus('att-1', TENANT_ID);
      expect(result).toBeNull();
    });
  });

  // ── Delete Attachment ────────────────────────────────────────────────────

  describe('deleteAttachment', () => {
    it('sends DELETE request', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(emptyResponse(204));

      await client.deleteAttachment('att-1', TENANT_ID);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/internal/attachments/att-1`);
      expect(opts.method).toBe('DELETE');
      expect(opts.headers['X-Tenant-Id']).toBe(TENANT_ID);
    });

    it('does not throw on network error', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      await expect(client.deleteAttachment('att-1', TENANT_ID)).resolves.toBeUndefined();
    });

    it('does not throw on server error', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(emptyResponse(500));

      await expect(client.deleteAttachment('att-1', TENANT_ID)).resolves.toBeUndefined();
    });
  });

  // ── Delete by Session ────────────────────────────────────────────────────

  describe('deleteBySession', () => {
    it('sends DELETE to session endpoint', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(emptyResponse(204));

      await client.deleteBySession(SESSION_ID, TENANT_ID);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/internal/attachments/session/${SESSION_ID}`);
      expect(opts.method).toBe('DELETE');
      expect(opts.headers['X-Tenant-Id']).toBe(TENANT_ID);
    });

    it('does not throw on network error', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      await expect(client.deleteBySession(SESSION_ID, TENANT_ID)).resolves.toBeUndefined();
    });
  });

  // ── Cross-cutting: X-Tenant-Id header ────────────────────────────────────

  describe('all methods send X-Tenant-Id header', () => {
    it('upload sends X-Tenant-Id', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        jsonResponse({ success: true, data: { attachmentId: 'a1', status: 'accepted' } }, 201),
      );
      await client.upload({
        stream: mockStream(),
        filename: 'f.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
        tenantId: 'tenant-x',
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      });
      expect(fetchSpy.mock.calls[0][1].headers['X-Tenant-Id']).toBe('tenant-x');
    });

    it('getAttachment sends X-Tenant-Id', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        jsonResponse({ success: true, data: { attachment: mockAttachment() } }),
      );
      await client.getAttachment('att-1', 'tenant-y');
      expect(fetchSpy.mock.calls[0][1].headers['X-Tenant-Id']).toBe('tenant-y');
    });

    it('listBySession sends X-Tenant-Id', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(jsonResponse({ success: true, data: { attachments: [] } }));
      await client.listBySession(SESSION_ID, 'tenant-z');
      expect(fetchSpy.mock.calls[0][1].headers['X-Tenant-Id']).toBe('tenant-z');
    });

    it('getDownloadUrl sends X-Tenant-Id', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        jsonResponse({ success: true, data: { url: 'https://x', expiresInSeconds: 60 } }),
      );
      await client.getDownloadUrl('att-1', 'tenant-w');
      expect(fetchSpy.mock.calls[0][1].headers['X-Tenant-Id']).toBe('tenant-w');
    });

    it('getStatus sends X-Tenant-Id', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        jsonResponse({
          success: true,
          data: { scanStatus: 'clean', processingStatus: 'completed', embeddingStatus: 'pending' },
        }),
      );
      await client.getStatus('att-1', 'tenant-v');
      expect(fetchSpy.mock.calls[0][1].headers['X-Tenant-Id']).toBe('tenant-v');
    });

    it('downloadAttachmentContent sends X-Tenant-Id', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(
        new Response(Buffer.from('bytes'), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      );
      await client.downloadAttachmentContent('att-1', 'tenant-q');
      expect(fetchSpy.mock.calls[0][1].headers['X-Tenant-Id']).toBe('tenant-q');
    });

    it('deleteAttachment sends X-Tenant-Id', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(emptyResponse(204));
      await client.deleteAttachment('att-1', 'tenant-u');
      expect(fetchSpy.mock.calls[0][1].headers['X-Tenant-Id']).toBe('tenant-u');
    });

    it('deleteBySession sends X-Tenant-Id', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(emptyResponse(204));
      await client.deleteBySession(SESSION_ID, 'tenant-t');
      expect(fetchSpy.mock.calls[0][1].headers['X-Tenant-Id']).toBe('tenant-t');
    });
  });

  // ── Network error handling ───────────────────────────────────────────────

  describe('handles network errors gracefully', () => {
    it('upload returns structured error', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

      const result = await client.upload({
        stream: mockStream(),
        filename: 'f.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      });
      expect(result).toEqual({
        success: false,
        error: { code: 'NETWORK_ERROR', message: 'Failed to fetch' },
      });
    });

    it('getAttachment returns null', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
      expect(await client.getAttachment('a', TENANT_ID)).toBeNull();
    });

    it('listBySession returns empty array', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
      expect(await client.listBySession(SESSION_ID, TENANT_ID)).toEqual([]);
    });

    it('getDownloadUrl returns null', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
      expect(await client.getDownloadUrl('a', TENANT_ID)).toBeNull();
    });

    it('getStatus returns null', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
      expect(await client.getStatus('a', TENANT_ID)).toBeNull();
    });

    it('downloadAttachmentContent returns null', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
      expect(await client.downloadAttachmentContent('a', TENANT_ID)).toBeNull();
    });

    it('deleteAttachment does not throw', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(client.deleteAttachment('a', TENANT_ID)).resolves.toBeUndefined();
    });

    it('deleteBySession does not throw', async () => {
      const client = createClient();
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(client.deleteBySession(SESSION_ID, TENANT_ID)).resolves.toBeUndefined();
    });
  });

  // ── URL encoding ─────────────────────────────────────────────────────────

  describe('URL encoding', () => {
    it('encodes attachment ID in URL', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(emptyResponse(404));

      await client.getAttachment('id/with/slashes', TENANT_ID);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('id%2Fwith%2Fslashes');
    });

    it('encodes session ID in URL', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValue(jsonResponse({ success: true, data: { attachments: [] } }));

      await client.listBySession('sess/special', TENANT_ID);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('sess%2Fspecial');
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  downloadWhatsAppMedia,
  type WhatsAppMediaReference,
  type WhatsAppMediaDownloadResult,
} from '../../../channels/adapters/whatsapp-providers/meta-cloud-media-downloader.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MEDIA_REF: WhatsAppMediaReference = {
  mediaId: 'media-123',
  mimeType: 'image/jpeg',
  mediaType: 'image',
  filename: undefined,
};

describe('downloadWhatsAppMedia', () => {
  it('performs two-step download and returns a readable stream', async () => {
    // Step 1: GET /media/{id} → returns URL
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123',
        mime_type: 'image/jpeg',
        file_size: 2048,
        id: 'media-123',
      }),
    });

    // Step 2: GET {url} → returns binary stream
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

    const result = await downloadWhatsAppMedia(MEDIA_REF, 'test-access-token');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.filename).toBe('image_media-123.jpeg');
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.sizeBytes).toBe(2048);
    }

    // Verify both fetch calls used Bearer auth
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-access-token');
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer test-access-token');
  });

  it('uses document filename when available', async () => {
    const docRef: WhatsAppMediaReference = {
      mediaId: 'media-456',
      mimeType: 'application/pdf',
      mediaType: 'document',
      filename: 'report.pdf',
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: 'https://lookaside.fbsbx.com/download',
        mime_type: 'application/pdf',
        file_size: 5000,
        id: 'media-456',
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.close();
        },
      }),
    });

    const result = await downloadWhatsAppMedia(docRef, 'token');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filename).toBe('report.pdf');
    }
  });

  it('returns error when media URL retrieval fails (step 1)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const result = await downloadWhatsAppMedia(MEDIA_REF, 'token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('404');
    }
    // Should NOT attempt step 2
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns error when file download fails (step 2)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: 'https://lookaside.fbsbx.com/download',
        mime_type: 'image/jpeg',
        file_size: 1024,
        id: 'media-123',
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    const result = await downloadWhatsAppMedia(MEDIA_REF, 'token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('403');
    }
  });

  it('returns error when file exceeds max size', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: 'https://lookaside.fbsbx.com/download',
        mime_type: 'video/mp4',
        file_size: 200_000_000,
        id: 'media-123',
      }),
    });

    const result = await downloadWhatsAppMedia(MEDIA_REF, 'token', {
      maxSizeBytes: 100_000_000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exceeds');
    }
    // Should NOT attempt step 2
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await downloadWhatsAppMedia(MEDIA_REF, 'token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Network error');
    }
  });
});

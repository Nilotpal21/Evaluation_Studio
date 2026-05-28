import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  downloadInfobipMedia,
  type InfobipMediaReference,
} from '../../../channels/adapters/whatsapp-providers/infobip-media-downloader.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createMockResponse(overrides: Record<string, any> = {}) {
  const headers = new Map(Object.entries(overrides.headers || {}));
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (key: string) => headers.get(key.toLowerCase()) ?? null,
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
    ...overrides,
    // Ensure headers override merges correctly
    ...(overrides.headers
      ? {
          headers: {
            get: (key: string) =>
              new Map(Object.entries(overrides.headers).map(([k, v]) => [k.toLowerCase(), v])).get(
                key.toLowerCase(),
              ) ?? null,
          },
        }
      : {}),
  };
}

const BASE_MEDIA_REF: InfobipMediaReference = {
  mediaId: 'infobip-direct',
  mimeType: 'image/jpeg',
  mediaType: 'image',
  url: 'https://api.infobip.com/whatsapp/1/senders/447860099299/media/photo.jpg',
};

describe('downloadInfobipMedia', () => {
  it('downloads from direct URL with API key auth header', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '2048',
        },
      }),
    );

    const result = await downloadInfobipMedia(BASE_MEDIA_REF, 'App my-api-key-123');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.sizeBytes).toBe(2048);
      expect(result.filename).toBe('photo.jpg');
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(BASE_MEDIA_REF.url);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('App my-api-key-123');
  });

  it('downloads from direct URL with Basic auth header', async () => {
    const basicAuth = 'Basic ' + Buffer.from('user:pass').toString('base64');

    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'image/png',
          'content-length': '4096',
        },
      }),
    );

    const mediaRef: InfobipMediaReference = {
      ...BASE_MEDIA_REF,
      mimeType: 'image/png',
      url: 'https://api.infobip.com/whatsapp/1/senders/123/media/screenshot.png',
    };

    const result = await downloadInfobipMedia(mediaRef, basicAuth);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.mimeType).toBe('image/png');
      expect(result.sizeBytes).toBe(4096);
      expect(result.filename).toBe('screenshot.png');
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe(basicAuth);
  });

  it('returns { success: false } on HTTP 404 error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const result = await downloadInfobipMedia(BASE_MEDIA_REF, 'App key');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('404');
      expect(result.error).toContain('Not Found');
      expect(result.mediaId).toBe('infobip-direct');
    }
  });

  it('returns { success: false } on HTTP 500 error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const result = await downloadInfobipMedia(BASE_MEDIA_REF, 'App key');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('500');
      expect(result.error).toContain('Internal Server Error');
      expect(result.mediaId).toBe('infobip-direct');
    }
  });

  it('returns { success: false } when response has no body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
      headers: {
        get: () => null,
      },
    });

    const result = await downloadInfobipMedia(BASE_MEDIA_REF, 'App key');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('no body');
      expect(result.mediaId).toBe('infobip-direct');
    }
  });

  it('generates correct filename from URL with extension', async () => {
    const mediaRef: InfobipMediaReference = {
      mediaId: 'infobip-direct',
      mimeType: 'video/mp4',
      mediaType: 'video',
      url: 'https://api.infobip.com/whatsapp/1/senders/123/media/clip.mp4',
    };

    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'video/mp4',
          'content-length': '10000',
        },
      }),
    );

    const result = await downloadInfobipMedia(mediaRef, 'App key');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filename).toBe('clip.mp4');
    }
  });

  it('generates filename from media type and mime when URL has no extension', async () => {
    const mediaRef: InfobipMediaReference = {
      mediaId: 'infobip-direct',
      mimeType: 'audio/mpeg',
      mediaType: 'audio',
      url: 'https://api.infobip.com/whatsapp/1/senders/123/media/abc123',
    };

    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': '5000',
        },
      }),
    );

    const result = await downloadInfobipMedia(mediaRef, 'App key');

    expect(result.success).toBe(true);
    if (result.success) {
      // URL path segment "abc123" has no extension, so fallback to generated name
      expect(result.filename).toMatch(/^audio_\d+\.mp3$/);
    }
  });

  it('uses explicit filename from mediaRef when provided', async () => {
    const mediaRef: InfobipMediaReference = {
      ...BASE_MEDIA_REF,
      filename: 'my-document.pdf',
    };

    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'application/pdf',
          'content-length': '8000',
        },
      }),
    );

    const result = await downloadInfobipMedia(mediaRef, 'App key');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filename).toBe('my-document.pdf');
    }
  });

  it('returns { success: false } when URL is empty', async () => {
    const mediaRef: InfobipMediaReference = {
      ...BASE_MEDIA_REF,
      url: '',
    };

    const result = await downloadInfobipMedia(mediaRef, 'App key');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Missing media URL');
    }
  });

  it('returns { success: false } on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await downloadInfobipMedia(BASE_MEDIA_REF, 'App key');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Network error');
    }
  });

  it('returns { success: false } when content-length exceeds max size', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'video/mp4',
          'content-length': '200000000',
        },
      }),
    );

    const result = await downloadInfobipMedia(BASE_MEDIA_REF, 'App key', {
      maxSizeBytes: 100_000_000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exceeds');
    }
  });

  it('prefers content-type from response headers over mediaRef mimeType', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'image/webp; charset=utf-8',
          'content-length': '1024',
        },
      }),
    );

    const result = await downloadInfobipMedia(BASE_MEDIA_REF, 'App key');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mimeType).toBe('image/webp');
    }
  });

  it('falls back to mediaRef.mimeType when Content-Type header is absent', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-length': '1024',
        },
      }),
    );

    const result = await downloadInfobipMedia(BASE_MEDIA_REF, 'App key');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mimeType).toBe('image/jpeg');
    }
  });

  it('falls back to application/octet-stream when both Content-Type and mediaRef.mimeType are absent', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-length': '1024',
        },
      }),
    );

    const mediaRef: InfobipMediaReference = {
      ...BASE_MEDIA_REF,
      mimeType: '',
    };

    const result = await downloadInfobipMedia(mediaRef, 'App key');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mimeType).toBe('application/octet-stream');
    }
  });

  it('respects custom timeoutMs option by passing AbortSignal', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '1024',
        },
      }),
    );

    await downloadInfobipMedia(BASE_MEDIA_REF, 'App key', {
      timeoutMs: 5000,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.signal).toBeDefined();
  });
});

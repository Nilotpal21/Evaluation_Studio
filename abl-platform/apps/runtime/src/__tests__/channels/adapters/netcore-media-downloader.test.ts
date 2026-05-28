import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  downloadNetcoreMedia,
  type NetcoreMediaReference,
} from '../../../channels/adapters/whatsapp-providers/netcore-media-downloader.js';

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

const BASE_MEDIA_REF: NetcoreMediaReference = {
  mediaId: 'media-id-123',
  mimeType: 'image/jpeg',
  mediaType: 'image',
};

describe('downloadNetcoreMedia', () => {
  it('successfully downloads media with correct stream, filename, mimeType, and sizeBytes', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '2048',
        },
      }),
    );

    const result = await downloadNetcoreMedia(BASE_MEDIA_REF, 'my-api-key');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.sizeBytes).toBe(2048);
      expect(result.filename).toMatch(/^image_\d+\.jpeg$/);
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      `https://waapi.pepipost.com/api/v2/media/${BASE_MEDIA_REF.mediaId}`,
    );
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer my-api-key');
  });

  it('returns { success: false } when mediaId is missing', async () => {
    const mediaRef: NetcoreMediaReference = {
      ...BASE_MEDIA_REF,
      mediaId: '',
    };

    const result = await downloadNetcoreMedia(mediaRef, 'my-api-key');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Missing media ID');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns { success: false } on HTTP 404 error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const result = await downloadNetcoreMedia(BASE_MEDIA_REF, 'my-api-key');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('404');
      expect(result.error).toContain('Not Found');
      expect(result.mediaId).toBe('media-id-123');
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

    const result = await downloadNetcoreMedia(BASE_MEDIA_REF, 'my-api-key', {
      maxSizeBytes: 100_000_000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exceeds');
      expect(result.mediaId).toBe('media-id-123');
    }
  });

  it('returns { success: false } on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await downloadNetcoreMedia(BASE_MEDIA_REF, 'my-api-key');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Network error');
      expect(result.mediaId).toBe('media-id-123');
    }
  });

  it('respects custom mediaApiUrl option', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '1024',
        },
      }),
    );

    await downloadNetcoreMedia(BASE_MEDIA_REF, 'my-api-key', {
      mediaApiUrl: 'https://custom-api.example.com/v3/media',
    });

    expect(mockFetch.mock.calls[0][0]).toBe(
      `https://custom-api.example.com/v3/media/${BASE_MEDIA_REF.mediaId}`,
    );
  });

  it('respects custom maxSizeBytes option (allows files under limit)', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'image/png',
          'content-length': '500',
        },
      }),
    );

    const result = await downloadNetcoreMedia(BASE_MEDIA_REF, 'my-api-key', {
      maxSizeBytes: 1000,
    });

    expect(result.success).toBe(true);
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

    await downloadNetcoreMedia(BASE_MEDIA_REF, 'my-api-key', {
      timeoutMs: 5000,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.signal).toBeDefined();
  });

  it('falls back to mediaRef.mimeType when Content-Type header is absent', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-length': '1024',
        },
      }),
    );

    const result = await downloadNetcoreMedia(BASE_MEDIA_REF, 'my-api-key');

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

    const mediaRef: NetcoreMediaReference = {
      ...BASE_MEDIA_REF,
      mimeType: '',
    };

    const result = await downloadNetcoreMedia(mediaRef, 'my-api-key');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mimeType).toBe('application/octet-stream');
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

    const result = await downloadNetcoreMedia(BASE_MEDIA_REF, 'my-api-key');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('no body');
      expect(result.mediaId).toBe('media-id-123');
    }
  });

  it('uses explicit filename from mediaRef when provided', async () => {
    const mediaRef: NetcoreMediaReference = {
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

    const result = await downloadNetcoreMedia(mediaRef, 'my-api-key');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filename).toBe('my-document.pdf');
    }
  });

  it('strips charset from Content-Type header', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': '512',
        },
      }),
    );

    const result = await downloadNetcoreMedia(BASE_MEDIA_REF, 'my-api-key');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mimeType).toBe('text/plain');
    }
  });

  it('returns "Unknown download error" for non-Error throws', async () => {
    mockFetch.mockRejectedValueOnce('string-error');

    const result = await downloadNetcoreMedia(BASE_MEDIA_REF, 'my-api-key');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Unknown download error');
    }
  });
});

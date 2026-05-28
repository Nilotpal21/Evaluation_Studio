import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  downloadGupshupMedia,
  type GupshupMediaReference,
} from '../../../channels/adapters/whatsapp-providers/gupshup-media-downloader.js';

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

const BASE_MEDIA_REF: GupshupMediaReference = {
  mediaId: 'gupshup-direct',
  mimeType: 'image/jpeg',
  mediaType: 'image',
  url: 'https://filemanager.gupshup.io/fm/wamedia/demobot/36c21b90-photo.jpg?signature=abc123',
};

describe('downloadGupshupMedia', () => {
  it('downloads from direct URL WITHOUT auth headers', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '2048',
        },
      }),
    );

    const result = await downloadGupshupMedia(BASE_MEDIA_REF);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.sizeBytes).toBe(2048);
      expect(result.filename).toBe('36c21b90-photo.jpg');
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(BASE_MEDIA_REF.url);
    // Key difference from Infobip: no Authorization header
    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.headers).toBeUndefined();
  });

  it('returns { success: false } on HTTP 404 error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const result = await downloadGupshupMedia(BASE_MEDIA_REF);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('404');
      expect(result.error).toContain('Not Found');
      expect(result.mediaId).toBe('gupshup-direct');
    }
  });

  it('returns { success: false } on HTTP 500 error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const result = await downloadGupshupMedia(BASE_MEDIA_REF);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('500');
      expect(result.error).toContain('Internal Server Error');
      expect(result.mediaId).toBe('gupshup-direct');
    }
  });

  it('returns { success: false } when URL is empty', async () => {
    const mediaRef: GupshupMediaReference = {
      ...BASE_MEDIA_REF,
      url: '',
    };

    const result = await downloadGupshupMedia(mediaRef);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Missing media URL');
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

    const result = await downloadGupshupMedia(BASE_MEDIA_REF, {
      maxSizeBytes: 100_000_000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exceeds');
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

    const result = await downloadGupshupMedia(BASE_MEDIA_REF);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('no body');
      expect(result.mediaId).toBe('gupshup-direct');
    }
  });

  it('handles voice URL with signature query params', async () => {
    const voiceRef: GupshupMediaReference = {
      mediaId: 'gupshup-direct',
      mimeType: 'audio/ogg',
      mediaType: 'audio',
      url: 'https://filemanager.gupshup.io/fm/wamedia/demobot/voice-note.ogg?signature=xyz789&expires=1234567890',
    };

    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'audio/ogg',
          'content-length': '15000',
        },
      }),
    );

    const result = await downloadGupshupMedia(voiceRef);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.mimeType).toBe('audio/ogg');
      expect(result.sizeBytes).toBe(15000);
      expect(result.filename).toBe('voice-note.ogg');
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(voiceRef.url);
  });

  it('generates filename from URL path when URL has extension', async () => {
    const mediaRef: GupshupMediaReference = {
      mediaId: 'gupshup-direct',
      mimeType: 'video/mp4',
      mediaType: 'video',
      url: 'https://filemanager.gupshup.io/fm/wamedia/demobot/clip.mp4',
    };

    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'video/mp4',
          'content-length': '10000',
        },
      }),
    );

    const result = await downloadGupshupMedia(mediaRef);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filename).toBe('clip.mp4');
    }
  });

  it('falls back to mediaType + extension when URL has no extension', async () => {
    const mediaRef: GupshupMediaReference = {
      mediaId: 'gupshup-direct',
      mimeType: 'audio/mpeg',
      mediaType: 'audio',
      url: 'https://filemanager.gupshup.io/fm/wamedia/demobot/abc123',
    };

    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': '5000',
        },
      }),
    );

    const result = await downloadGupshupMedia(mediaRef);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filename).toMatch(/^audio_\d+\.mp3$/);
    }
  });

  it('returns { success: false } on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await downloadGupshupMedia(BASE_MEDIA_REF);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Network error');
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

    const result = await downloadGupshupMedia(BASE_MEDIA_REF);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mimeType).toBe('image/webp');
    }
  });
});

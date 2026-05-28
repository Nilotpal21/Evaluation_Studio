import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  downloadInstagramMedia,
  type InstagramMediaReference,
} from '../../../channels/adapters/instagram-media-downloader.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const IMAGE_REF: InstagramMediaReference = {
  type: 'image',
  url: 'https://scontent.cdninstagram.com/v/t51.2885-15/photo.jpg?_nc_ht=abc&_nc_cat=def',
};

function makeSuccessResponse(
  contentType = 'image/jpeg',
  contentLength = '2048',
): Record<string, unknown> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name: string) => {
        if (name === 'content-type') return contentType;
        if (name === 'content-length') return contentLength;
        return null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
  };
}

describe('downloadInstagramMedia', () => {
  it('downloads image from Instagram CDN successfully', async () => {
    mockFetch.mockResolvedValueOnce(makeSuccessResponse());

    const result = await downloadInstagramMedia(IMAGE_REF);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.filename).toMatch(/^instagram_image_\d+\.jpeg$/);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.sizeBytes).toBe(2048);
    }

    // Should NOT use any auth headers (CDN URLs have embedded signatures)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1]).not.toHaveProperty('headers');
  });

  it('generates correct filename for video media type', async () => {
    const videoRef: InstagramMediaReference = {
      type: 'video',
      url: 'https://video.cdninstagram.com/v/t50.2886-16/reel.mp4?_nc_ht=abc',
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('video/mp4', '10000'));

    const result = await downloadInstagramMedia(videoRef);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filename).toMatch(/^instagram_video_\d+\.mp4$/);
      expect(result.mimeType).toBe('video/mp4');
    }
  });

  // ── CDN host allowlist (SSRF protection) ──────────────────────────────

  it('blocks download from non-Meta CDN host', async () => {
    const maliciousRef: InstagramMediaReference = {
      type: 'image',
      url: 'http://169.254.169.254/latest/meta-data/',
    };

    const result = await downloadInstagramMedia(maliciousRef);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not a recognized Meta CDN domain');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks download from lookalike domain', async () => {
    const lookalike: InstagramMediaReference = {
      type: 'image',
      url: 'https://evil-cdninstagram.com/exploit.jpg',
    };

    const result = await downloadInstagramMedia(lookalike);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not a recognized Meta CDN domain');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows download from cdninstagram.com', async () => {
    mockFetch.mockResolvedValueOnce(makeSuccessResponse());
    const result = await downloadInstagramMedia(IMAGE_REF);
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('allows download from fbcdn.net', async () => {
    const ref: InstagramMediaReference = {
      type: 'image',
      url: 'https://scontent.xx.fbcdn.net/v/t51.2885-15/photo.jpg?oh=abc',
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse());
    const result = await downloadInstagramMedia(ref);
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('allows download from instagram.com', async () => {
    const ref: InstagramMediaReference = {
      type: 'image',
      url: 'https://scontent.instagram.com/v/photo.jpg?oh=abc',
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse());
    const result = await downloadInstagramMedia(ref);
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // ── Error handling ──────────────────────────────────────────────────────

  it('rejects HTML responses (expired URL)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'text/html; charset=utf-8';
          return null;
        },
      },
      body: new ReadableStream(),
    });

    const result = await downloadInstagramMedia(IMAGE_REF);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('HTML');
      expect(result.error).toContain('expired');
    }
  });

  it('rejects oversized files', async () => {
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('image/jpeg', '200000000'));

    const result = await downloadInstagramMedia(IMAGE_REF, { maxSizeBytes: 100_000_000 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exceeds');
    }
  });

  it('returns error for missing URL', async () => {
    const noUrlRef = { type: 'image', url: '' } as InstagramMediaReference;
    const result = await downloadInstagramMedia(noUrlRef);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Missing media URL');
    }
  });

  it('returns error when HTTP response is not ok', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => null },
    });

    const result = await downloadInstagramMedia(IMAGE_REF);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('403');
      expect(result.error).toContain('Forbidden');
    }
  });

  it('returns error when response has no body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'image/jpeg';
          if (name === 'content-length') return '100';
          return null;
        },
      },
      body: null,
    });

    const result = await downloadInstagramMedia(IMAGE_REF);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('no body');
    }
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await downloadInstagramMedia(IMAGE_REF);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Network error');
    }
  });

  // ── Streaming size enforcement ──────────────────────────────────────────

  it('enforces size limit during streaming when Content-Length is absent (chunked)', async () => {
    // Simulate chunked response: no Content-Length header, passes the header check,
    // but the stream delivers more bytes than the limit.
    const maxSize = 10;
    const oversizedChunk = new Uint8Array(maxSize + 50);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'image/jpeg';
          // No content-length — simulates chunked transfer encoding
          if (name === 'content-length') return null;
          return null;
        },
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(oversizedChunk);
          controller.close();
        },
      }),
    });

    const result = await downloadInstagramMedia(IMAGE_REF, { maxSizeBytes: maxSize });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // The stream should error when consumed, not silently pass through
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of result.stream) {
        chunks.push(Buffer.from(chunk));
      }
      // Should not reach here
      expect.unreachable('Stream should have errored on size limit');
    } catch (err) {
      expect((err as Error).message).toContain('exceeded max size');
    }
  });

  it('allows chunked streams within size limit', async () => {
    const smallChunk = new Uint8Array([1, 2, 3, 4, 5]);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'image/png';
          if (name === 'content-length') return null; // chunked
          return null;
        },
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(smallChunk);
          controller.close();
        },
      }),
    });

    const result = await downloadInstagramMedia(IMAGE_REF, { maxSizeBytes: 100 });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Stream should complete successfully
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).length).toBe(5);
  });
});

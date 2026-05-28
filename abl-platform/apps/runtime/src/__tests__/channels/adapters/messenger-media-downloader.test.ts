import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  downloadMessengerMedia,
  type MessengerMediaReference,
} from '../../../channels/adapters/messenger-media-downloader.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const IMAGE_REF: MessengerMediaReference = {
  type: 'image',
  url: 'https://scontent.xx.fbcdn.net/v/t1.15752-9/photo.jpg?oh=abc&oe=def',
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

describe('downloadMessengerMedia', () => {
  it('downloads from Facebook CDN and returns a readable stream', async () => {
    mockFetch.mockResolvedValueOnce(makeSuccessResponse());

    const result = await downloadMessengerMedia(IMAGE_REF);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.filename).toMatch(/^messenger_image_\d+\.jpeg$/);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.sizeBytes).toBe(2048);
    }

    // Should NOT use any auth headers (CDN URLs have embedded signatures)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1]).not.toHaveProperty('headers');
  });

  it('generates correct filename for different media types', async () => {
    const videoRef: MessengerMediaReference = {
      type: 'video',
      url: 'https://video.xx.fbcdn.net/v/video.mp4?oh=abc',
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('video/mp4', '10000'));

    const result = await downloadMessengerMedia(videoRef);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filename).toMatch(/^messenger_video_\d+\.mp4$/);
      expect(result.mimeType).toBe('video/mp4');
    }
  });

  it('handles mime types with parameters (e.g. audio/ogg; codecs=opus)', async () => {
    const audioRef: MessengerMediaReference = {
      type: 'audio',
      url: 'https://cdn.fbsbx.com/audio.ogg?oh=abc',
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('audio/ogg; codecs=opus', '5000'));

    const result = await downloadMessengerMedia(audioRef);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mimeType).toBe('audio/ogg');
      expect(result.filename).toMatch(/\.ogg$/);
    }
  });

  it('uses "bin" extension for unknown mime types', async () => {
    const fileRef: MessengerMediaReference = {
      type: 'file',
      url: 'https://cdn.fbsbx.com/file.xyz?oh=abc',
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('application/x-custom', '1000'));

    const result = await downloadMessengerMedia(fileRef);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filename).toMatch(/\.bin$/);
    }
  });

  // ── CDN host allowlist ──────────────────────────────────────────────────

  it('blocks download from non-Facebook CDN host', async () => {
    const maliciousRef: MessengerMediaReference = {
      type: 'image',
      url: 'http://169.254.169.254/latest/meta-data/',
    };

    const result = await downloadMessengerMedia(maliciousRef);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not a recognized Facebook CDN domain');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks download from lookalike domain', async () => {
    const lookalike: MessengerMediaReference = {
      type: 'image',
      url: 'https://evil-fbcdn.net/exploit.jpg',
    };

    const result = await downloadMessengerMedia(lookalike);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not a recognized Facebook CDN domain');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows download from scontent.xx.fbcdn.net', async () => {
    mockFetch.mockResolvedValueOnce(makeSuccessResponse());
    const result = await downloadMessengerMedia(IMAGE_REF);
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('allows download from cdn.fbsbx.com', async () => {
    const ref: MessengerMediaReference = {
      type: 'file',
      url: 'https://cdn.fbsbx.com/v/document.pdf?oh=abc',
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('application/pdf', '3000'));
    const result = await downloadMessengerMedia(ref);
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('allows download from video.xx.fbcdn.net', async () => {
    const ref: MessengerMediaReference = {
      type: 'video',
      url: 'https://video.xx.fbcdn.net/v/video.mp4?oh=abc',
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('video/mp4', '5000'));
    const result = await downloadMessengerMedia(ref);
    expect(result.success).toBe(true);
  });

  it('blocks download with invalid URL', async () => {
    const badRef: MessengerMediaReference = {
      type: 'image',
      url: 'not-a-url',
    };
    const result = await downloadMessengerMedia(badRef);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not a recognized Facebook CDN domain');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Error handling ──────────────────────────────────────────────────────

  it('returns error when URL is missing', async () => {
    const noUrlRef = { type: 'image', url: '' } as MessengerMediaReference;
    const result = await downloadMessengerMedia(noUrlRef);
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

    const result = await downloadMessengerMedia(IMAGE_REF);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('403');
      expect(result.error).toContain('Forbidden');
    }
  });

  it('returns error when response is HTML (expired URL)', async () => {
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

    const result = await downloadMessengerMedia(IMAGE_REF);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('HTML');
      expect(result.error).toContain('expired');
    }
  });

  it('returns error when file exceeds max size', async () => {
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('image/jpeg', '200000000'));

    const result = await downloadMessengerMedia(IMAGE_REF, { maxSizeBytes: 100_000_000 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exceeds');
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

    const result = await downloadMessengerMedia(IMAGE_REF);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('no body');
    }
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await downloadMessengerMedia(IMAGE_REF);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Network error');
    }
  });

  it('defaults to application/octet-stream when content-type header is missing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: () => null,
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.close();
        },
      }),
    });

    const result = await downloadMessengerMedia(IMAGE_REF);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mimeType).toBe('application/octet-stream');
      expect(result.filename).toMatch(/\.bin$/);
    }
  });

  it('sets sizeBytes to 0 when content-length header is missing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'image/png';
          return null;
        },
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.close();
        },
      }),
    });

    const result = await downloadMessengerMedia(IMAGE_REF);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.sizeBytes).toBe(0);
    }
  });
});

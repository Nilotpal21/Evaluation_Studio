import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import {
  downloadLineMedia,
  type LineMediaReference,
} from '../channels/adapters/line-media-downloader.js';

vi.stubGlobal('fetch', vi.fn());
const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;

function successResponse(
  body: string,
  headers: Record<string, string> = {
    'content-type': 'image/jpeg',
    'content-length': String(body.length),
  },
): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (key: string) => headers[key.toLowerCase()] || null,
    },
    body: Readable.toWeb(Readable.from(body)) as never,
  } as unknown as Response;
}

describe('downloadLineMedia', () => {
  const mediaRef: LineMediaReference = {
    messageId: 'msg-1',
    mediaType: 'image',
    mimeType: 'image/jpeg',
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('downloads media with bearer auth', async () => {
    mockFetch.mockResolvedValue(successResponse('image-bytes'));

    const result = await downloadLineMedia(mediaRef, 'access-token');

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/msg-1/content',
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
      }),
    );
    if (result.success) {
      expect(result.filename).toBe('image_msg-1.jpg');
      expect(result.mimeType).toBe('image/jpeg');
    }
  });

  it('rejects files above the max size before downloading', async () => {
    const result = await downloadLineMedia(
      { ...mediaRef, sizeBytes: 25 * 1024 * 1024 },
      'access-token',
      { maxSizeBytes: 20 * 1024 * 1024 },
    );

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects oversized downloads based on content-length', async () => {
    mockFetch.mockResolvedValue(
      successResponse('image-bytes', {
        'content-type': 'image/jpeg',
        'content-length': String(30 * 1024 * 1024),
      }),
    );

    const result = await downloadLineMedia(mediaRef, 'access-token', {
      maxSizeBytes: 20 * 1024 * 1024,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exceeds max size');
    }
  });
});

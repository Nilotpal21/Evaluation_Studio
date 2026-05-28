import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  downloadTelegramMedia,
  type TelegramMediaReference,
} from '../channels/adapters/telegram-media-downloader.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.stubGlobal('fetch', vi.fn());
const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;

const BOT_TOKEN = 'test-bot-token';
const API_BASE = 'https://api.telegram.org';

function makeMediaRef(overrides?: Partial<TelegramMediaReference>): TelegramMediaReference {
  return {
    fileId: 'abc123',
    mimeType: 'image/jpeg',
    mediaType: 'photo',
    ...overrides,
  };
}

function getFileResponse(overrides?: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      ok: true,
      result: {
        file_id: 'abc123',
        file_unique_id: 'unique1',
        file_path: 'photos/file_1.jpg',
        file_size: 1024,
        ...overrides,
      },
    }),
  };
}

function downloadResponse(body?: ReadableStream) {
  return {
    ok: true,
    body:
      body ??
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      }),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ===========================================================================
// downloadTelegramMedia
// ===========================================================================

describe('downloadTelegramMedia', () => {
  it('successful download: two-step process (getFile then download)', async () => {
    mockFetch.mockResolvedValueOnce(getFileResponse());
    mockFetch.mockResolvedValueOnce(downloadResponse());

    const result = await downloadTelegramMedia(makeMediaRef(), BOT_TOKEN);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it('verify getFile URL format: /bot{token}/getFile?file_id={id}', async () => {
    mockFetch.mockResolvedValueOnce(getFileResponse());
    mockFetch.mockResolvedValueOnce(downloadResponse());

    await downloadTelegramMedia(makeMediaRef(), BOT_TOKEN);

    const getFileUrl = mockFetch.mock.calls[0][0] as string;
    expect(getFileUrl).toBe(`${API_BASE}/bot${BOT_TOKEN}/getFile?file_id=abc123`);
  });

  it('verify download URL format: /file/bot{token}/{file_path}', async () => {
    mockFetch.mockResolvedValueOnce(getFileResponse());
    mockFetch.mockResolvedValueOnce(downloadResponse());

    await downloadTelegramMedia(makeMediaRef(), BOT_TOKEN);

    const downloadUrl = mockFetch.mock.calls[1][0] as string;
    expect(downloadUrl).toBe(`${API_BASE}/file/bot${BOT_TOKEN}/photos/file_1.jpg`);
  });

  it('returns stream, filename, mimeType, sizeBytes on success', async () => {
    mockFetch.mockResolvedValueOnce(getFileResponse());
    mockFetch.mockResolvedValueOnce(downloadResponse());

    const result = await downloadTelegramMedia(makeMediaRef({ filename: 'photo.jpg' }), BOT_TOKEN);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.stream).toBeDefined();
    expect(result.filename).toBe('photo.jpg');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.sizeBytes).toBe(1024);
  });

  it('missing fileId returns error result', async () => {
    const result = await downloadTelegramMedia(makeMediaRef({ fileId: '' }), BOT_TOKEN);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('Missing fileId');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('file exceeds maxSizeBytes (known upfront from mediaRef.fileSize) returns error without download', async () => {
    const result = await downloadTelegramMedia(makeMediaRef({ fileSize: 5000 }), BOT_TOKEN, {
      maxSizeBytes: 1000,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('exceeds max size');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('file exceeds maxSizeBytes (discovered from getFile response) returns error without download', async () => {
    mockFetch.mockResolvedValueOnce(getFileResponse({ file_size: 5000 }));

    const result = await downloadTelegramMedia(makeMediaRef(), BOT_TOKEN, {
      maxSizeBytes: 1000,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('exceeds max size');
    // Only one fetch call (getFile), no download
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('getFile returns non-ok response results in error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await downloadTelegramMedia(makeMediaRef(), BOT_TOKEN);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('getFile failed');
    expect(result.error).toContain('404');
  });

  it('getFile returns no file_path results in error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { file_id: 'abc123' } }),
    });

    const result = await downloadTelegramMedia(makeMediaRef(), BOT_TOKEN);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('no file_path');
  });

  it('download returns non-ok response results in error', async () => {
    mockFetch.mockResolvedValueOnce(getFileResponse());
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await downloadTelegramMedia(makeMediaRef(), BOT_TOKEN);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('download failed');
    expect(result.error).toContain('500');
  });

  it('download returns no body results in error', async () => {
    mockFetch.mockResolvedValueOnce(getFileResponse());
    mockFetch.mockResolvedValueOnce({ ok: true, body: null });

    const result = await downloadTelegramMedia(makeMediaRef(), BOT_TOKEN);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('no body');
  });

  it('network error results in error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await downloadTelegramMedia(makeMediaRef(), BOT_TOKEN);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('ECONNREFUSED');
    expect(result.fileId).toBe('abc123');
  });

  it('custom apiBase option works', async () => {
    const customBase = 'https://custom-telegram.example.com';
    mockFetch.mockResolvedValueOnce(getFileResponse());
    mockFetch.mockResolvedValueOnce(downloadResponse());

    await downloadTelegramMedia(makeMediaRef(), BOT_TOKEN, { apiBase: customBase });

    const getFileUrl = mockFetch.mock.calls[0][0] as string;
    const downloadUrl = mockFetch.mock.calls[1][0] as string;
    expect(getFileUrl).toContain(customBase);
    expect(downloadUrl).toContain(customBase);
  });

  it('filename fallback: {mediaType}_{fileId}.{extension}', async () => {
    mockFetch.mockResolvedValueOnce(getFileResponse());
    mockFetch.mockResolvedValueOnce(downloadResponse());

    // No filename in mediaRef
    const result = await downloadTelegramMedia(makeMediaRef({ filename: undefined }), BOT_TOKEN);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.filename).toBe('photo_abc123.jpeg');
  });

  it('filename from mediaRef used when available', async () => {
    mockFetch.mockResolvedValueOnce(getFileResponse());
    mockFetch.mockResolvedValueOnce(downloadResponse());

    const result = await downloadTelegramMedia(
      makeMediaRef({ filename: 'my-vacation.jpg' }),
      BOT_TOKEN,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.filename).toBe('my-vacation.jpg');
  });
});

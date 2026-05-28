import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadMSTeamsFile,
  type MSTeamsFileReference,
} from '../../../channels/adapters/msteams-file-downloader.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const FILE_REF: MSTeamsFileReference = {
  source: 'file_download_info',
  name: 'report.pdf',
  mimeType: 'application/pdf',
  downloadUrl: 'https://contoso.sharepoint.com/report.pdf',
  sizeBytes: 1024,
};

describe('downloadMSTeamsFile', () => {
  const originalAllowedHosts = process.env.MSTEAMS_ATTACHMENT_BEARER_ALLOWED_HOSTS;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MSTEAMS_ATTACHMENT_BEARER_ALLOWED_HOSTS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAllowedHosts === undefined) {
      delete process.env.MSTEAMS_ATTACHMENT_BEARER_ALLOWED_HOSTS;
    } else {
      process.env.MSTEAMS_ATTACHMENT_BEARER_ALLOWED_HOSTS = originalAllowedHosts;
    }
  });

  it('downloads a file without auth when URL allows direct access', async () => {
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-type': 'application/pdf',
        'content-length': '3',
      }),
      body: bodyStream,
    });

    const result = await downloadMSTeamsFile(FILE_REF);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.filename).toBe('report.pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.sizeBytes).toBe(3);
    }
  });

  it('retries with bearer token on 401/403', async () => {
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: new Headers(),
        body: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({
          'content-type': 'application/pdf',
          'content-length': '2',
        }),
        body: bodyStream,
      });

    const result = await downloadMSTeamsFile(FILE_REF, { botToken: 'bot-token-1' });
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer bot-token-1' }),
      }),
    );
  });

  it('returns error when file exceeds configured max size', async () => {
    const result = await downloadMSTeamsFile(
      { ...FILE_REF, sizeBytes: 10_000_000 },
      { maxSizeBytes: 1024 },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exceeds max size');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects HTML responses that indicate non-file content', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: null,
    });
    const result = await downloadMSTeamsFile(FILE_REF);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('HTML');
    }
  });

  it('refuses to attach bot token for untrusted hosts', async () => {
    const result = await downloadMSTeamsFile(
      {
        ...FILE_REF,
        source: 'inline_image',
        downloadUrl: 'https://evil.example.com/malicious.png',
        requiresBotToken: true,
      },
      { botToken: 'bot-token-1' },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Refusing to send Teams bot token');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

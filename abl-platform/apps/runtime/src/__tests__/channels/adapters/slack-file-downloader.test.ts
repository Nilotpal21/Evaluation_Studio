import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

// We'll mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  downloadSlackFile,
  type SlackFileReference,
  type SlackFileDownloadResult,
} from '../../../channels/adapters/slack-file-downloader.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const FILE_REF: SlackFileReference = {
  slackFileId: 'F123',
  name: 'report.pdf',
  mimetype: 'application/pdf',
  filetype: 'pdf',
  size: 1024,
  downloadUrl: 'https://files.slack.com/files-pri/T123-F123/download/report.pdf',
};

describe('downloadSlackFile', () => {
  it('downloads a file and returns a readable stream', async () => {
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      body: bodyStream,
    });

    const result = await downloadSlackFile(FILE_REF, 'xoxb-test-token');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.filename).toBe('report.pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.sizeBytes).toBe(1024);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      FILE_REF.downloadUrl,
      expect.objectContaining({
        headers: { Authorization: 'Bearer xoxb-test-token' },
      }),
    );
  });

  it('returns error on HTTP failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Headers({ 'content-type': 'application/json' }),
      clone() {
        return this;
      },
      text: vi.fn().mockResolvedValue('{"ok":false,"error":"missing_scope"}'),
    });

    const result = await downloadSlackFile(FILE_REF, 'xoxb-test-token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('403');
      expect(result.details).toEqual(
        expect.objectContaining({
          reason: 'http_error',
          statusCode: 403,
          statusText: 'Forbidden',
          contentType: 'application/json',
          responseSnippet: '{"ok":false,"error":"missing_scope"}',
        }),
      );
    }
  });

  it('returns error when file exceeds max size', async () => {
    const bigFile: SlackFileReference = { ...FILE_REF, size: 200_000_000 };
    const result = await downloadSlackFile(bigFile, 'xoxb-test-token', {
      maxSizeBytes: 100_000_000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exceeds');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await downloadSlackFile(FILE_REF, 'xoxb-test-token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Network error');
      expect(result.details).toEqual(
        expect.objectContaining({
          reason: 'network_error',
          timeoutMs: 30_000,
        }),
      );
    }
  });

  it('returns HTML failure details when Slack serves an auth/error page', async () => {
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html>missing scope</html>'));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: bodyStream,
      clone() {
        return {
          text: vi.fn().mockResolvedValue('<html>missing scope</html>'),
        };
      },
    });

    const result = await downloadSlackFile(FILE_REF, 'xoxb-test-token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('files:read');
      expect(result.details).toEqual(
        expect.objectContaining({
          reason: 'html_error_page',
          contentType: 'text/html; charset=utf-8',
          responseSnippet: '<html>missing scope</html>',
        }),
      );
    }
  });
});

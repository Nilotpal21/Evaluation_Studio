import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSafeFetch = vi.hoisted(() => vi.fn());

vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  safeFetch: mockSafeFetch,
}));

vi.mock('../../../config/index.js', () => ({
  getConfig: () => ({
    storage: {
      basePath: './uploads',
      region: 'us-east-1',
    },
  }),
}));

import { downloadDocumentContent } from '../download-document.js';

describe('downloadDocumentContent', () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
  });

  it('downloads HTTP documents through safeFetch', async () => {
    const body = Buffer.from('document');
    mockSafeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: vi
        .fn()
        .mockResolvedValue(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
    } as unknown as Response);

    const result = await downloadDocumentContent('https://docs.example.com/file.pdf');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://docs.example.com/file.pdf',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.objectContaining({ maxRedirects: 5 }),
    );
  });

  it('propagates safeFetch SSRF blocks for HTTP documents', async () => {
    mockSafeFetch.mockRejectedValue(new Error('URL resolved to a blocked private address'));

    await expect(downloadDocumentContent('https://metadata.google.internal/file')).rejects.toThrow(
      /blocked private/,
    );
  });
});

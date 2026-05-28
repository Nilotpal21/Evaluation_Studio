import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchMultimodalServiceClient } from '@/lib/arch-ai/multimodal-service-client';

describe('ArchMultimodalServiceClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads attachment bytes from the internal content endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from('image-bytes'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );

    const client = new ArchMultimodalServiceClient('http://multimodal-service');
    const result = await client.downloadContent('att-123', 'tenant-1', { disposition: 'inline' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://multimodal-service/internal/attachments/att-123/content?disposition=inline',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Tenant-Id': 'tenant-1' },
      }),
    );
    expect(result).toEqual({
      buffer: Buffer.from('image-bytes'),
      contentType: 'image/png',
    });
  });
});

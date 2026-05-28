import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';

import {
  processInstagramMediaReferences,
  type InstagramMediaReferenceMetadata,
} from '../../../channels/adapters/instagram-media-processor.js';

const BASE_OPTIONS = {
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  channel: 'instagram' as const,
};

describe('processInstagramMediaReferences', () => {
  it('returns empty array when no references provided', async () => {
    const result = await processInstagramMediaReferences([], {
      ...BASE_OPTIONS,
      downloadFn: vi.fn(),
      uploadFn: vi.fn(),
    });

    expect(result).toEqual([]);
  });

  it('downloads and uploads a single image, returning attachmentId', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('image-data')),
      filename: 'instagram_image_123.jpeg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    });

    const mockUpload = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-ig-001',
      status: 'pending',
    });

    const refs: InstagramMediaReferenceMetadata[] = [
      { type: 'image', url: 'https://scontent.cdninstagram.com/photo.jpg?sig=abc' },
    ];

    const result = await processInstagramMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-ig-001']);
    expect(mockDownload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'instagram_image_123.jpeg',
        mimeType: 'image/jpeg',
        tenantId: 'tenant-1',
        channel: 'instagram',
      }),
    );
  });

  it('continues on download failure, processing remaining refs', async () => {
    const mockDownload = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: 'URL expired',
      })
      .mockResolvedValueOnce({
        success: true,
        stream: Readable.from(Buffer.from('video-data')),
        filename: 'instagram_video_456.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 4096,
      });

    const mockUpload = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-ig-002',
      status: 'pending',
    });

    const refs: InstagramMediaReferenceMetadata[] = [
      { type: 'image', url: 'https://scontent.cdninstagram.com/expired.jpg' },
      { type: 'video', url: 'https://scontent.cdninstagram.com/video.mp4?sig=def' },
    ];

    const result = await processInstagramMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-ig-002']);
    expect(mockDownload).toHaveBeenCalledTimes(2);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('continues on upload failure, returning empty for that ref', async () => {
    const stream = Readable.from(Buffer.from('data'));
    const destroySpy = vi.spyOn(stream, 'destroy');

    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream,
      filename: 'instagram_file_789.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });

    const mockUpload = vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'UPLOAD_FAILED', message: 'Service unavailable' },
    });

    const refs: InstagramMediaReferenceMetadata[] = [
      { type: 'file', url: 'https://scontent.cdninstagram.com/doc.pdf?sig=abc' },
    ];

    const result = await processInstagramMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual([]);
    expect(destroySpy).toHaveBeenCalled();
  });

  it('destroys stream on exception', async () => {
    const stream = Readable.from(Buffer.from('data'));
    const destroySpy = vi.spyOn(stream, 'destroy');

    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream,
      filename: 'instagram_image_100.jpeg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    });
    const mockUpload = vi.fn().mockRejectedValue(new Error('Upload crash'));

    const refs: InstagramMediaReferenceMetadata[] = [
      { type: 'image', url: 'https://scontent.cdninstagram.com/photo.jpg?sig=abc' },
    ];

    const result = await processInstagramMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual([]);
    expect(destroySpy).toHaveBeenCalled();
  });
});

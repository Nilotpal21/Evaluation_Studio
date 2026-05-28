import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';

import {
  processMessengerMediaReferences,
  type MessengerMediaReferenceMetadata,
} from '../../../channels/adapters/messenger-media-processor.js';

const BASE_OPTIONS = {
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  channel: 'messenger' as const,
};

describe('processMessengerMediaReferences', () => {
  it('downloads and uploads media, returning attachmentIds', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('image-data')),
      filename: 'messenger_image_123.jpeg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    });

    const mockUpload = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-msg-001',
      status: 'pending',
    });

    const refs: MessengerMediaReferenceMetadata[] = [
      { type: 'image', url: 'https://scontent.xx.fbcdn.net/photo.jpg?oh=abc' },
    ];

    const result = await processMessengerMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-msg-001']);
    expect(mockDownload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'messenger_image_123.jpeg',
        mimeType: 'image/jpeg',
        tenantId: 'tenant-1',
        channel: 'messenger',
      }),
    );
  });

  it('skips failed downloads gracefully', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: false,
      error: 'URL expired',
    });
    const mockUpload = vi.fn();

    const refs: MessengerMediaReferenceMetadata[] = [
      { type: 'image', url: 'https://scontent.xx.fbcdn.net/expired.jpg' },
    ];

    const result = await processMessengerMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual([]);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('skips failed uploads and destroys stream', async () => {
    const stream = Readable.from(Buffer.from('data'));
    const destroySpy = vi.spyOn(stream, 'destroy');

    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream,
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });
    const mockUpload = vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'UPLOAD_FAILED', message: 'Service unavailable' },
    });

    const refs: MessengerMediaReferenceMetadata[] = [
      { type: 'file', url: 'https://cdn.fbsbx.com/doc.pdf?oh=abc' },
    ];

    const result = await processMessengerMediaReferences(refs, {
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
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    });
    const mockUpload = vi.fn().mockRejectedValue(new Error('Upload crash'));

    const refs: MessengerMediaReferenceMetadata[] = [
      { type: 'image', url: 'https://scontent.xx.fbcdn.net/photo.jpg?oh=abc' },
    ];

    const result = await processMessengerMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual([]);
    expect(destroySpy).toHaveBeenCalled();
  });

  it('processes multiple media concurrently, collecting successes', async () => {
    const mockDownload = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stream: Readable.from(Buffer.from('img')),
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'HTTP 404',
      })
      .mockResolvedValueOnce({
        success: true,
        stream: Readable.from(Buffer.from('pdf')),
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 500,
      });

    const mockUpload = vi
      .fn()
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-1', status: 'pending' })
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-3', status: 'pending' });

    const refs: MessengerMediaReferenceMetadata[] = [
      { type: 'image', url: 'https://scontent.xx.fbcdn.net/img1.jpg?oh=a' },
      { type: 'audio', url: 'https://cdn.fbsbx.com/audio.ogg?oh=b' },
      { type: 'file', url: 'https://cdn.fbsbx.com/report.pdf?oh=c' },
    ];

    const result = await processMessengerMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-1', 'att-3']);
    expect(mockDownload).toHaveBeenCalledTimes(3);
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when no references provided', async () => {
    const result = await processMessengerMediaReferences([], {
      ...BASE_OPTIONS,
      downloadFn: vi.fn(),
      uploadFn: vi.fn(),
    });

    expect(result).toEqual([]);
  });

  it('does not pass auth token to download function', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('data')),
      filename: 'img.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    });
    const mockUpload = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-1',
      status: 'pending',
    });

    const refs: MessengerMediaReferenceMetadata[] = [
      { type: 'image', url: 'https://scontent.xx.fbcdn.net/photo.jpg?oh=abc' },
    ];

    await processMessengerMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    // downloadFn is called with only the ref (no token), unlike WhatsApp/Slack
    expect(mockDownload).toHaveBeenCalledWith(refs[0]);
  });
});

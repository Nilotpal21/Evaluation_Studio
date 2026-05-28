import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';

import {
  processWhatsAppMediaReferences,
  type WhatsAppMediaReferenceMetadata,
} from '../../../channels/adapters/whatsapp-media-processor.js';

describe('processWhatsAppMediaReferences', () => {
  it('downloads and uploads media, returning attachmentIds', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('image-data')),
      filename: 'image_media-1.jpeg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    });

    const mockUpload = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-wa-001',
      status: 'pending',
    });

    const refs: WhatsAppMediaReferenceMetadata[] = [
      {
        mediaId: 'media-1',
        mimeType: 'image/jpeg',
        mediaType: 'image',
        filename: undefined,
      },
    ];

    const result = await processWhatsAppMediaReferences(refs, {
      accessToken: 'test-token',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'whatsapp',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-wa-001']);
    expect(mockDownload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledOnce();
  });

  it('skips failed downloads gracefully', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: false,
      error: 'HTTP 404',
      mediaId: 'media-2',
    });
    const mockUpload = vi.fn();

    const refs: WhatsAppMediaReferenceMetadata[] = [
      { mediaId: 'media-2', mimeType: 'image/png', mediaType: 'image', filename: undefined },
    ];

    const result = await processWhatsAppMediaReferences(refs, {
      accessToken: 'test-token',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'whatsapp',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual([]);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('skips failed uploads gracefully', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('data')),
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });
    const mockUpload = vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'UPLOAD_FAILED', message: 'Service unavailable' },
    });

    const refs: WhatsAppMediaReferenceMetadata[] = [
      {
        mediaId: 'media-3',
        mimeType: 'application/pdf',
        mediaType: 'document',
        filename: 'doc.pdf',
      },
    ];

    const result = await processWhatsAppMediaReferences(refs, {
      accessToken: 'test-token',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'whatsapp',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual([]);
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
        mediaId: 'media-b',
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

    const refs: WhatsAppMediaReferenceMetadata[] = [
      { mediaId: 'media-a', mimeType: 'image/jpeg', mediaType: 'image', filename: undefined },
      { mediaId: 'media-b', mimeType: 'audio/ogg', mediaType: 'audio', filename: undefined },
      {
        mediaId: 'media-c',
        mimeType: 'application/pdf',
        mediaType: 'document',
        filename: 'report.pdf',
      },
    ];

    const result = await processWhatsAppMediaReferences(refs, {
      accessToken: 'test-token',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'whatsapp',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-1', 'att-3']);
  });

  it('returns empty array when no references provided', async () => {
    const result = await processWhatsAppMediaReferences([], {
      accessToken: 'test-token',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'whatsapp',
      downloadFn: vi.fn(),
      uploadFn: vi.fn(),
    });

    expect(result).toEqual([]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';

import {
  processTwilioMediaReferences,
  type TwilioMediaReferenceMetadata,
} from '../../../channels/adapters/twilio-sms-media-processor.js';

const BASE_OPTIONS = {
  accountSid: 'AC1234567890abcdef1234567890abcdef',
  authToken: 'test_auth_token_secret_123',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  channel: 'twilio_sms' as const,
};

describe('processTwilioMediaReferences', () => {
  it('downloads and uploads media, returning attachmentIds', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('image-data')),
      filename: 'twilio_mms_0_123.jpeg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    });

    const mockUpload = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-twilio-001',
      status: 'pending',
    });

    const refs: TwilioMediaReferenceMetadata[] = [
      {
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME789',
        contentType: 'image/jpeg',
        index: 0,
      },
    ];

    const result = await processTwilioMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-twilio-001']);
    expect(mockDownload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'twilio_mms_0_123.jpeg',
        mimeType: 'image/jpeg',
        tenantId: 'tenant-1',
        channel: 'twilio_sms',
      }),
    );
  });

  it('skips failed downloads gracefully', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: false,
      error: 'URL expired',
    });
    const mockUpload = vi.fn();

    const refs: TwilioMediaReferenceMetadata[] = [
      {
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME001',
        contentType: 'image/jpeg',
        index: 0,
      },
    ];

    const result = await processTwilioMediaReferences(refs, {
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
      filename: 'twilio_mms_0_123.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });
    const mockUpload = vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'UPLOAD_FAILED', message: 'Service unavailable' },
    });

    const refs: TwilioMediaReferenceMetadata[] = [
      {
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME002',
        contentType: 'application/pdf',
        index: 0,
      },
    ];

    const result = await processTwilioMediaReferences(refs, {
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
      filename: 'twilio_mms_0_123.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    });
    const mockUpload = vi.fn().mockRejectedValue(new Error('Upload crash'));

    const refs: TwilioMediaReferenceMetadata[] = [
      {
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME003',
        contentType: 'image/jpeg',
        index: 0,
      },
    ];

    const result = await processTwilioMediaReferences(refs, {
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
        filename: 'twilio_mms_0_123.jpeg',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'HTTP 404',
      })
      .mockResolvedValueOnce({
        success: true,
        stream: Readable.from(Buffer.from('vid')),
        filename: 'twilio_mms_2_123.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 500,
      });

    const mockUpload = vi
      .fn()
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-1', status: 'pending' })
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-3', status: 'pending' });

    const refs: TwilioMediaReferenceMetadata[] = [
      {
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME001',
        contentType: 'image/jpeg',
        index: 0,
      },
      {
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME002',
        contentType: 'image/png',
        index: 1,
      },
      {
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME003',
        contentType: 'video/mp4',
        index: 2,
      },
    ];

    const result = await processTwilioMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-1', 'att-3']);
    expect(mockDownload).toHaveBeenCalledTimes(3);
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when no references provided', async () => {
    const result = await processTwilioMediaReferences([], {
      ...BASE_OPTIONS,
      downloadFn: vi.fn(),
      uploadFn: vi.fn(),
    });

    expect(result).toEqual([]);
  });

  it('passes only the media ref to downloadFn', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('data')),
      filename: 'twilio_mms_0_123.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    });
    const mockUpload = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-1',
      status: 'pending',
    });

    const refs: TwilioMediaReferenceMetadata[] = [
      {
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME789',
        contentType: 'image/jpeg',
        index: 0,
      },
    ];

    await processTwilioMediaReferences(refs, {
      ...BASE_OPTIONS,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(mockDownload).toHaveBeenCalledWith(refs[0]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processEmailAttachments,
  type EmailAttachmentRef,
  type EmailProcessOptions,
} from '../../../channels/adapters/email-attachment-processor.js';
import type { UploadResult } from '../../../attachments/multimodal-service-client.js';

const BASE_OPTIONS: EmailProcessOptions = {
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  channel: 'email',
};

function makeAttachment(overrides?: Partial<EmailAttachmentRef>): EmailAttachmentRef {
  return {
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    content: Buffer.from('fake-file-content'),
    ...overrides,
  };
}

describe('processEmailAttachments', () => {
  let uploadFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    uploadFn = vi.fn();
  });

  it('returns empty array for empty input', async () => {
    const result = await processEmailAttachments([], { ...BASE_OPTIONS, uploadFn });
    expect(result).toEqual([]);
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it('uploads a single attachment and returns its ID', async () => {
    uploadFn.mockResolvedValueOnce({
      success: true,
      attachmentId: 'att-123',
      status: 'uploaded',
    } as UploadResult);

    const att = makeAttachment();
    const result = await processEmailAttachments([att], { ...BASE_OPTIONS, uploadFn });

    expect(result).toEqual(['att-123']);
    expect(uploadFn).toHaveBeenCalledOnce();
    expect(uploadFn).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        channel: 'email',
      }),
    );
  });

  it('uploads multiple attachments in parallel', async () => {
    uploadFn
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-1', status: 'uploaded' })
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-2', status: 'uploaded' });

    const attachments = [
      makeAttachment({ filename: 'file1.pdf' }),
      makeAttachment({ filename: 'file2.jpg', mimeType: 'image/jpeg', sizeBytes: 2048 }),
    ];

    const result = await processEmailAttachments(attachments, { ...BASE_OPTIONS, uploadFn });
    expect(result).toEqual(['att-1', 'att-2']);
    expect(uploadFn).toHaveBeenCalledTimes(2);
  });

  it('skips individual upload failures without blocking others', async () => {
    uploadFn
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-1', status: 'uploaded' })
      .mockResolvedValueOnce({
        success: false,
        error: { code: 'UPLOAD_FAILED', message: 'Disk full' },
      })
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-3', status: 'uploaded' });

    const attachments = [
      makeAttachment({ filename: 'a.pdf' }),
      makeAttachment({ filename: 'b.pdf' }),
      makeAttachment({ filename: 'c.pdf' }),
    ];

    const result = await processEmailAttachments(attachments, { ...BASE_OPTIONS, uploadFn });
    expect(result).toEqual(['att-1', 'att-3']);
  });

  it('catches thrown errors and skips the file', async () => {
    uploadFn.mockRejectedValueOnce(new Error('Network timeout'));

    const result = await processEmailAttachments([makeAttachment()], {
      ...BASE_OPTIONS,
      uploadFn,
    });
    expect(result).toEqual([]);
  });

  it('skips attachments exceeding size limit', async () => {
    const oversized = makeAttachment({
      filename: 'huge.zip',
      sizeBytes: 21 * 1024 * 1024, // 21 MB, over 20 MB limit
    });
    const normal = makeAttachment({ filename: 'small.pdf', sizeBytes: 1024 });
    uploadFn.mockResolvedValueOnce({
      success: true,
      attachmentId: 'att-small',
      status: 'uploaded',
    });

    const result = await processEmailAttachments([oversized, normal], {
      ...BASE_OPTIONS,
      uploadFn,
    });

    expect(result).toEqual(['att-small']);
    expect(uploadFn).toHaveBeenCalledOnce(); // only called for the small file
  });

  it('converts Buffer content to a Readable stream for upload', async () => {
    const content = Buffer.from('hello world');
    uploadFn.mockImplementation(async (params: any) => {
      // Read the stream to verify it contains the original buffer data
      const chunks: Buffer[] = [];
      for await (const chunk of params.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const result = Buffer.concat(chunks);
      expect(result.toString()).toBe('hello world');
      return { success: true, attachmentId: 'att-stream', status: 'uploaded' };
    });

    const att = makeAttachment({ content, sizeBytes: content.length });
    const result = await processEmailAttachments([att], { ...BASE_OPTIONS, uploadFn });
    expect(result).toEqual(['att-stream']);
  });

  it('emits attachment upload traces when a callback is provided', async () => {
    const onTraceEvent = vi.fn();
    uploadFn.mockResolvedValueOnce({
      success: true,
      attachmentId: 'att-trace',
      status: 'uploaded',
    });

    await processEmailAttachments([makeAttachment()], {
      ...BASE_OPTIONS,
      provider: 'email',
      onTraceEvent,
      uploadFn,
    });

    expect(onTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'attachment_upload',
        data: expect.objectContaining({
          channel: 'email',
          provider: 'email',
          stage: 'upload',
          success: true,
          attachmentId: 'att-trace',
        }),
      }),
    );
  });
});

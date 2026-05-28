import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';

import {
  processSlackFileReferences,
  type SlackFileReferenceMetadata,
} from '../channels/adapters/slack-file-processor.js';

describe('processSlackFileReferences', () => {
  it('downloads and uploads files, returning attachmentIds', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('file-content')),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });

    const mockUpload = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-123',
      status: 'pending',
    });

    const fileRefs: SlackFileReferenceMetadata[] = [
      {
        slackFileId: 'F123',
        name: 'report.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 1024,
        downloadUrl: 'https://files.slack.com/files-pri/T123-F123/download/report.pdf',
      },
    ];

    const result = await processSlackFileReferences(fileRefs, {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-123']);
    expect(mockDownload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledOnce();
  });

  it('skips failed downloads gracefully', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: false,
      error: 'HTTP 403',
      slackFileId: 'F123',
    });
    const mockUpload = vi.fn();

    const fileRefs: SlackFileReferenceMetadata[] = [
      {
        slackFileId: 'F123',
        name: 'secret.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 1024,
        downloadUrl: 'https://files.slack.com/download/secret.pdf',
      },
    ];

    const result = await processSlackFileReferences(fileRefs, {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual([]);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('skips failed uploads gracefully', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('file-content')),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });
    const mockUpload = vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'UPLOAD_FAILED', message: 'Service unavailable' },
    });

    const fileRefs: SlackFileReferenceMetadata[] = [
      {
        slackFileId: 'F123',
        name: 'report.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 1024,
        downloadUrl: 'https://files.slack.com/download/report.pdf',
      },
    ];

    const result = await processSlackFileReferences(fileRefs, {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual([]);
  });

  it('processes multiple files concurrently, collecting all successful IDs', async () => {
    const mockDownload = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stream: Readable.from(Buffer.from('file1')),
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'HTTP 404',
        slackFileId: 'F2',
      })
      .mockResolvedValueOnce({
        success: true,
        stream: Readable.from(Buffer.from('file3')),
        filename: 'c.png',
        mimeType: 'image/png',
        sizeBytes: 200,
      });

    const mockUpload = vi
      .fn()
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-1', status: 'pending' })
      .mockResolvedValueOnce({ success: true, attachmentId: 'att-3', status: 'pending' });

    const fileRefs: SlackFileReferenceMetadata[] = [
      {
        slackFileId: 'F1',
        name: 'a.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 100,
        downloadUrl: 'https://url/a',
      },
      {
        slackFileId: 'F2',
        name: 'b.doc',
        mimetype: 'application/msword',
        filetype: 'doc',
        size: 300,
        downloadUrl: 'https://url/b',
      },
      {
        slackFileId: 'F3',
        name: 'c.png',
        mimetype: 'image/png',
        filetype: 'png',
        size: 200,
        downloadUrl: 'https://url/c',
      },
    ];

    const result = await processSlackFileReferences(fileRefs, {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual(['att-1', 'att-3']);
  });

  it('emits attachment download and upload traces when a callback is provided', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('file-content')),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });
    const mockUpload = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-123',
      status: 'pending',
    });
    const onTraceEvent = vi.fn();

    const fileRefs: SlackFileReferenceMetadata[] = [
      {
        slackFileId: 'F123',
        name: 'report.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 1024,
        downloadUrl: 'https://files.slack.com/files-pri/T123-F123/download/report.pdf',
      },
    ];

    await processSlackFileReferences(fileRefs, {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      provider: 'slack',
      onTraceEvent,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(onTraceEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'attachment_process',
        data: expect.objectContaining({
          channel: 'slack',
          provider: 'slack',
          stage: 'download',
          success: true,
        }),
      }),
    );
    expect(onTraceEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'attachment_upload',
        data: expect.objectContaining({
          channel: 'slack',
          provider: 'slack',
          stage: 'upload',
          success: true,
          attachmentId: 'att-123',
        }),
      }),
    );
  });

  it('emits an upload-stage failure trace when upload throws unexpectedly', async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('file-content')),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });
    const mockUpload = vi.fn().mockRejectedValue(new Error('storage boom'));
    const onTraceEvent = vi.fn();

    const fileRefs: SlackFileReferenceMetadata[] = [
      {
        slackFileId: 'F123',
        name: 'report.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 1024,
        downloadUrl: 'https://files.slack.com/files-pri/T123-F123/download/report.pdf',
      },
    ];

    const result = await processSlackFileReferences(fileRefs, {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      provider: 'slack',
      onTraceEvent,
      downloadFn: mockDownload,
      uploadFn: mockUpload,
    });

    expect(result).toEqual([]);
    expect(onTraceEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'attachment_process',
        data: expect.objectContaining({
          stage: 'download',
          success: true,
        }),
      }),
    );
    expect(onTraceEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'attachment_upload',
        data: expect.objectContaining({
          channel: 'slack',
          provider: 'slack',
          stage: 'upload',
          success: false,
          filename: 'report.pdf',
          error: 'storage boom',
        }),
      }),
    );
  });

  it('returns empty array when no file references provided', async () => {
    const result = await processSlackFileReferences([], {
      botToken: 'xoxb-test',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      channel: 'slack',
      downloadFn: vi.fn(),
      uploadFn: vi.fn(),
    });

    expect(result).toEqual([]);
  });
});

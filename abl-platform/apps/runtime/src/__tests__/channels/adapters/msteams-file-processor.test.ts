import { Readable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import {
  processMSTeamsFileReferences,
  type MSTeamsFileReferenceMetadata,
} from '../../../channels/adapters/msteams-file-processor.js';

describe('processMSTeamsFileReferences', () => {
  const refs: MSTeamsFileReferenceMetadata[] = [
    {
      source: 'file_download_info',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      downloadUrl: 'https://contoso.sharepoint.com/report.pdf',
    },
  ];

  it('downloads and uploads files, returning attachment IDs', async () => {
    const downloadFn = vi.fn().mockResolvedValue({
      success: true,
      stream: Readable.from(Buffer.from('file-content')),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });
    const uploadFn = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-1',
      status: 'pending',
    });

    const result = await processMSTeamsFileReferences(refs, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      channel: 'msteams',
      downloadFn,
      uploadFn,
    });

    expect(result).toEqual(['att-1']);
    expect(downloadFn).toHaveBeenCalledOnce();
    expect(uploadFn).toHaveBeenCalledOnce();
  });

  it('skips failed downloads gracefully', async () => {
    const downloadFn = vi.fn().mockResolvedValue({
      success: false,
      error: 'HTTP 403',
      filename: 'report.pdf',
    });
    const uploadFn = vi.fn();

    const result = await processMSTeamsFileReferences(refs, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      channel: 'msteams',
      downloadFn,
      uploadFn,
    });

    expect(result).toEqual([]);
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it('collects successful IDs when some files fail', async () => {
    const downloadFn = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stream: Readable.from(Buffer.from('a')),
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'HTTP 500',
        filename: 'b.pdf',
      });
    const uploadFn = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-a',
      status: 'pending',
    });

    const result = await processMSTeamsFileReferences(
      [
        refs[0],
        {
          source: 'file_download_info',
          name: 'other.pdf',
          mimeType: 'application/pdf',
          downloadUrl: 'https://contoso.sharepoint.com/other.pdf',
        },
      ],
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        channel: 'msteams',
        downloadFn,
        uploadFn,
      },
    );

    expect(result).toEqual(['att-a']);
  });
});

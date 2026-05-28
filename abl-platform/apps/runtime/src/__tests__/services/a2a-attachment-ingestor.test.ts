import { describe, expect, it, vi } from 'vitest';
import { createA2AAttachmentIngestor } from '../../services/a2a/attachment-ingestor.js';

describe('createA2AAttachmentIngestor', () => {
  it('uploads inline file bytes and returns attachment ids', async () => {
    const uploadFn = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-inline-1',
      status: 'accepted',
    });

    const ingest = createA2AAttachmentIngestor({
      resolveConfigFn: vi.fn().mockResolvedValue({
        enabled: true,
        maxFileSizeBytes: 1024 * 1024,
        maxFilesPerSession: 5,
        allowedMimeTypes: ['application/pdf'],
        piiPolicy: 'redact',
        defaultProcessingMode: 'full',
      }),
      uploadFn,
    });

    const attachmentIds = await ingest({
      sessionId: 'session-a2a-1',
      context: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        connectionId: 'conn-1',
      },
      attachments: [
        {
          name: 'contract.pdf',
          mimeType: 'application/pdf',
          bytes: Buffer.from('pdf-body').toString('base64'),
        },
      ],
    });

    expect(attachmentIds).toEqual(['att-inline-1']);
    expect(uploadFn).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'contract.pdf',
        mimeType: 'application/pdf',
        maxSizeBytes: 1024 * 1024,
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-a2a-1',
        channel: 'a2a',
        config: expect.objectContaining({
          maxFileSizeBytes: 1024 * 1024,
          maxAttachmentsPerSession: 5,
          allowedMimeTypes: ['application/pdf'],
        }),
      }),
    );
  });

  it('decodes data URI file parts before upload', async () => {
    const uploadFn = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-data-uri',
      status: 'accepted',
    });

    const ingest = createA2AAttachmentIngestor({
      resolveConfigFn: vi.fn().mockResolvedValue({
        enabled: true,
        maxFileSizeBytes: 1024 * 1024,
        maxFilesPerSession: 5,
        allowedMimeTypes: ['text/plain'],
        piiPolicy: 'redact',
        defaultProcessingMode: 'full',
      }),
      uploadFn,
    });

    const attachmentIds = await ingest({
      sessionId: 'session-a2a-2',
      context: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        connectionId: 'conn-1',
      },
      attachments: [
        {
          name: 'hello.txt',
          uri: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
        },
      ],
    });

    expect(attachmentIds).toEqual(['att-data-uri']);
    expect(uploadFn).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'hello.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
      }),
    );
  });

  it('skips remote URI-only attachments', async () => {
    const uploadFn = vi.fn();

    const ingest = createA2AAttachmentIngestor({
      resolveConfigFn: vi.fn().mockResolvedValue({
        enabled: true,
        maxFileSizeBytes: 1024 * 1024,
        maxFilesPerSession: 5,
        allowedMimeTypes: ['application/pdf'],
        piiPolicy: 'redact',
        defaultProcessingMode: 'full',
      }),
      uploadFn,
    });

    const attachmentIds = await ingest({
      sessionId: 'session-a2a-3',
      context: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        connectionId: 'conn-1',
      },
      attachments: [
        {
          name: 'remote.pdf',
          uri: 'https://example.com/remote.pdf',
        },
      ],
    });

    expect(attachmentIds).toEqual([]);
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it('returns no attachments when attachment ingestion is disabled', async () => {
    const uploadFn = vi.fn();

    const ingest = createA2AAttachmentIngestor({
      resolveConfigFn: vi.fn().mockResolvedValue({
        enabled: false,
        maxFileSizeBytes: 1024 * 1024,
        maxFilesPerSession: 5,
        allowedMimeTypes: ['application/pdf'],
        piiPolicy: 'redact',
        defaultProcessingMode: 'full',
      }),
      uploadFn,
    });

    const attachmentIds = await ingest({
      sessionId: 'session-a2a-4',
      context: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        connectionId: 'conn-1',
      },
      attachments: [
        {
          name: 'contract.pdf',
          mimeType: 'application/pdf',
          bytes: Buffer.from('pdf-body').toString('base64'),
        },
      ],
    });

    expect(attachmentIds).toEqual([]);
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it('skips attachments that violate the resolved MIME policy', async () => {
    const uploadFn = vi.fn();

    const ingest = createA2AAttachmentIngestor({
      resolveConfigFn: vi.fn().mockResolvedValue({
        enabled: true,
        maxFileSizeBytes: 1024 * 1024,
        maxFilesPerSession: 5,
        allowedMimeTypes: ['application/pdf'],
        piiPolicy: 'redact',
        defaultProcessingMode: 'full',
      }),
      uploadFn,
    });

    const attachmentIds = await ingest({
      sessionId: 'session-a2a-5',
      context: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        connectionId: 'conn-1',
      },
      attachments: [
        {
          name: 'image.png',
          mimeType: 'image/png',
          bytes: Buffer.from('png-body').toString('base64'),
        },
      ],
    });

    expect(attachmentIds).toEqual([]);
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it('allows A2A attachments through wildcard MIME policy after filename normalization', async () => {
    const uploadFn = vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-wildcard',
      status: 'accepted',
    });

    const ingest = createA2AAttachmentIngestor({
      resolveConfigFn: vi.fn().mockResolvedValue({
        enabled: true,
        maxFileSizeBytes: 1024 * 1024,
        maxFilesPerSession: 5,
        allowedMimeTypes: ['text/*'],
        piiPolicy: 'redact',
        defaultProcessingMode: 'full',
      }),
      uploadFn,
    });

    const attachmentIds = await ingest({
      sessionId: 'session-a2a-6',
      context: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        connectionId: 'conn-1',
      },
      attachments: [
        {
          name: 'notes.md',
          bytes: Buffer.from('# Notes').toString('base64'),
        },
      ],
    });

    expect(attachmentIds).toEqual(['att-wildcard']);
    expect(uploadFn).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'notes.md',
        mimeType: 'text/markdown',
        config: expect.objectContaining({
          allowedMimeTypes: ['text/*'],
        }),
      }),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAttachment, IArchSessionAttachment } from '@agent-platform/database';
import type { Model } from 'mongoose';
import { ArchAttachmentFileStore } from '@/lib/arch-ai/file-store';

const { mockResolveArchAttachmentConfig } = vi.hoisted(() => ({
  mockResolveArchAttachmentConfig: vi.fn(),
}));

vi.mock('@/lib/arch-ai/attachment-config-resolver', () => ({
  resolveArchAttachmentConfig: mockResolveArchAttachmentConfig,
}));

function createFindOneResult<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
  };
}

describe('ArchAttachmentFileStore', () => {
  beforeEach(() => {
    mockResolveArchAttachmentConfig.mockResolvedValue({
      enabled: true,
      maxFileSizeBytes: 10 * 1024 * 1024,
      maxFilesPerSession: 100,
      allowedMimeTypes: ['application/pdf', 'text/markdown', 'text/plain'],
      piiPolicy: 'redact',
      defaultProcessingMode: 'full',
    });
  });

  it('hydrates image blobs with downloaded base64 content for getByBlobId', async () => {
    const mapping = {
      _id: 'blob-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      phase: 'ONBOARDING',
      attachmentId: 'att-1',
      name: 'diagram.png',
      mediaType: 'image/png',
      size: 128,
      contentHash: 'hash-1',
      metadata: { width: 12, height: 10, tokenEstimate: 50 },
      status: 'active',
      createdAt: new Date('2026-04-20T00:00:00.000Z'),
    } as unknown as IArchSessionAttachment;

    const model = {
      findOne: vi.fn().mockReturnValue(createFindOneResult(mapping)),
    } as unknown as Model<IArchSessionAttachment>;

    const client = {
      getAttachment: vi.fn().mockResolvedValue({
        category: 'image',
        scanStatus: 'clean',
      } as Partial<IAttachment> as IAttachment),
      downloadContent: vi.fn().mockResolvedValue({
        buffer: Buffer.from('png-bytes'),
        contentType: 'image/png',
      }),
    };

    const store = new ArchAttachmentFileStore(model, client as never);
    const result = await store.getByBlobId(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
      'blob-1',
    );

    expect(client.downloadContent).toHaveBeenCalledWith('att-1', 'tenant-1', {
      disposition: 'inline',
    });
    expect(result.content).toEqual(Buffer.from('png-bytes'));
    expect(result.imageSource).toEqual({
      type: 'base64',
      data: Buffer.from('png-bytes').toString('base64'),
      mediaType: 'image/png',
    });
  });

  it('keeps getActiveFiles lightweight and skips image byte downloads', async () => {
    const mapping = {
      _id: 'blob-2',
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      phase: 'ONBOARDING',
      attachmentId: 'att-2',
      name: 'wireframe.png',
      mediaType: 'image/png',
      size: 256,
      contentHash: 'hash-2',
      metadata: { width: 20, height: 10, tokenEstimate: 75 },
      status: 'active',
      createdAt: new Date('2026-04-20T00:00:00.000Z'),
    } as unknown as IArchSessionAttachment;

    const lean = vi.fn().mockResolvedValue([mapping]);
    const sort = vi.fn().mockReturnValue({ lean });
    const model = {
      find: vi.fn().mockReturnValue({ sort }),
    } as unknown as Model<IArchSessionAttachment>;

    const client = {
      getAttachment: vi.fn().mockResolvedValue({
        category: 'image',
        scanStatus: 'clean',
      } as Partial<IAttachment> as IAttachment),
      downloadContent: vi.fn(),
    };

    const store = new ArchAttachmentFileStore(model, client as never);
    const result = await store.getActiveFiles(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'session-1',
    );

    expect(client.downloadContent).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('active');
    expect(result[0]?.imageSource).toBeNull();
    expect(result[0]?.content).toEqual(Buffer.alloc(0));
  });

  it('normalizes octet-stream markdown uploads by filename before sending to multimodal', async () => {
    const findOne = vi.fn().mockReturnValue(createFindOneResult(null));
    const create = vi.fn().mockResolvedValue({});
    const model = {
      aggregate: vi.fn().mockResolvedValue([]),
      findOne,
      create,
    } as unknown as Model<IArchSessionAttachment>;
    const client = {
      upload: vi.fn().mockResolvedValue({
        success: true,
        attachmentId: 'att-md-1',
        status: 'accepted',
      }),
    };
    const content = Buffer.from('# Notes');

    const store = new ArchAttachmentFileStore(model, client as never);
    const result = await store.upload(
      { tenantId: 'tenant-1', userId: 'user-1' },
      {
        _id: 'session-1',
        metadata: { projectId: 'project-1', phase: 'ONBOARDING' },
      },
      {
        name: 'notes.md',
        type: 'application/octet-stream',
        size: content.length,
        content: content.toString('base64'),
      },
    );

    expect(result.blobId).toBeTruthy();
    expect(client.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'notes.md',
        mimeType: 'text/markdown',
        config: expect.objectContaining({
          allowedMimeTypes: expect.arrayContaining(['text/markdown']),
        }),
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'notes.md',
        mediaType: 'text/markdown',
        attachmentId: 'att-md-1',
      }),
    );
  });
});

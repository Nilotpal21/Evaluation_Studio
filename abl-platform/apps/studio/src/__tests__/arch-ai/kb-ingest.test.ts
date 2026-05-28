// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  attachmentDownloadBlobContentMock,
  checkToolPermissionMock,
  clientGetMock,
  clientPostFormDataMock,
  clientPostMock,
  createKBApiClientMock,
  fileStoreGetByBlobIdMock,
  resolveKBContextMock,
} = vi.hoisted(() => ({
  attachmentDownloadBlobContentMock: vi.fn(),
  checkToolPermissionMock: vi.fn(),
  clientGetMock: vi.fn(),
  clientPostFormDataMock: vi.fn(),
  clientPostMock: vi.fn(),
  createKBApiClientMock: vi.fn(),
  fileStoreGetByBlobIdMock: vi.fn(),
  resolveKBContextMock: vi.fn(),
}));

vi.mock('@/lib/arch-ai/guards', () => ({
  checkToolPermission: checkToolPermissionMock,
}));

vi.mock('@/lib/arch-ai/message-services', () => ({
  attachmentFileStoreService: {
    downloadBlobContent: attachmentDownloadBlobContentMock,
  },
  fileStoreService: {
    getByBlobId: fileStoreGetByBlobIdMock,
  },
}));

vi.mock('@/lib/arch-ai/tools/kb-api-client', () => ({
  createKBApiClient: createKBApiClientMock,
}));

vi.mock('@/lib/arch-ai/tools/kb-context', () => ({
  resolveKBContext: resolveKBContextMock,
}));

import { executeKBIngest } from '@/lib/arch-ai/tools/kb-ingest';

function makeCtx() {
  return {
    projectId: 'proj-1',
    user: {
      permissions: ['tool:read', 'tool:write'],
      tenantId: 'tenant-1',
      userId: 'user-1',
    },
  };
}

function makeEnv() {
  return {
    pageContext: null,
    authToken: 'auth-token',
    sessionId: 'session-1',
  };
}

describe('executeKBIngest', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    checkToolPermissionMock.mockResolvedValue({ allowed: true });
    resolveKBContextMock.mockResolvedValue({ kbId: 'kb-1', availableKBs: [] });

    createKBApiClientMock.mockReturnValue({
      get: clientGetMock,
      post: clientPostMock,
      patch: vi.fn(),
      del: vi.fn(),
      postFormData: clientPostFormDataMock,
    });

    clientGetMock.mockImplementation(async (path: string) => {
      if (path === '/api/search-ai/knowledge-bases/kb-1') {
        return {
          knowledgeBase: {
            _id: 'kb-1',
            name: 'Support KB',
            searchIndexId: 'index-1',
          },
        };
      }

      if (path === '/api/search-ai/indexes/index-1/sources?limit=200&sourceType=manual') {
        return {
          sources: [{ _id: 'source-manual', name: 'Arch AI Uploads' }],
        };
      }

      if (path === '/api/search-ai/indexes/index-1/sources?limit=200&sourceType=web') {
        return { sources: [] };
      }

      throw new Error(`Unexpected GET ${path}`);
    });
  });

  it('uploads collected files through the real Search AI multipart route', async () => {
    attachmentDownloadBlobContentMock.mockResolvedValue({
      mapping: {
        name: 'support-guide.pdf',
        mediaType: 'application/pdf',
        sessionId: 'session-1',
      },
      contentType: 'application/pdf',
      buffer: Buffer.from('pdf-data'),
    });
    clientPostFormDataMock.mockResolvedValue({
      id: 'doc-1',
      status: 'pending',
    });

    const result = await executeKBIngest(
      {
        action: 'upload_file',
        kbId: 'kb-1',
        blobId: 'blob-1',
        metadata: { category: 'manual' },
      },
      makeCtx(),
      makeEnv(),
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        kbId: 'kb-1',
        kbName: 'Support KB',
        indexId: 'index-1',
        sourceId: 'source-manual',
        sourceName: 'Arch AI Uploads',
        sourceType: 'manual',
        blobId: 'blob-1',
        fileName: 'support-guide.pdf',
        id: 'doc-1',
        status: 'pending',
      },
    });

    expect(clientPostFormDataMock).toHaveBeenCalledTimes(1);
    const [path, formData] = clientPostFormDataMock.mock.calls[0] as [string, FormData];
    expect(path).toBe('/api/search-ai/indexes/index-1/sources/source-manual/documents');
    expect(formData.get('metadata')).toBe(JSON.stringify({ category: 'manual' }));
    expect(formData.get('file')).toBeInstanceOf(Blob);
  });

  it('stores inline text by uploading a synthesized text document', async () => {
    clientGetMock.mockImplementation(async (path: string) => {
      if (path === '/api/search-ai/knowledge-bases/kb-1') {
        return {
          knowledgeBase: {
            _id: 'kb-1',
            name: 'Support KB',
            searchIndexId: 'index-1',
          },
        };
      }

      if (path === '/api/search-ai/indexes/index-1/sources?limit=200&sourceType=manual') {
        return { sources: [] };
      }

      throw new Error(`Unexpected GET ${path}`);
    });
    clientPostMock.mockImplementation(async (path: string) => {
      if (path === '/api/search-ai/indexes/index-1/sources') {
        return {
          source: {
            _id: 'source-notes',
            name: 'Arch AI Notes',
          },
        };
      }

      throw new Error(`Unexpected POST ${path}`);
    });
    clientPostFormDataMock.mockResolvedValue({
      id: 'doc-text-1',
      status: 'pending',
    });

    const result = await executeKBIngest(
      {
        action: 'add_text',
        kbId: 'kb-1',
        text: 'Release notes for the latest search rollout.',
        title: 'Release Notes',
      },
      makeCtx(),
      makeEnv(),
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        kbId: 'kb-1',
        kbName: 'Support KB',
        indexId: 'index-1',
        sourceId: 'source-notes',
        sourceName: 'Arch AI Notes',
        sourceType: 'manual',
        sourceCreated: true,
        fileName: 'Release-Notes.txt',
        id: 'doc-text-1',
        status: 'pending',
      },
    });

    expect(clientPostMock).toHaveBeenCalledWith('/api/search-ai/indexes/index-1/sources', {
      name: 'Arch AI Notes',
      sourceType: 'manual',
    });

    const [path, formData] = clientPostFormDataMock.mock.calls[0] as [string, FormData];
    expect(path).toBe('/api/search-ai/indexes/index-1/sources/source-notes/documents');
    expect(formData.get('metadata')).toBe(JSON.stringify({ title: 'Release Notes' }));
    expect(formData.get('file')).toBeInstanceOf(Blob);
  });

  it('queues URL ingestion through the crawl batch API and surfaces the crawl warning', async () => {
    clientPostMock.mockImplementation(async (path: string, body?: Record<string, unknown>) => {
      if (path === '/api/search-ai/indexes/index-1/sources') {
        return {
          source: {
            _id: 'source-urls',
            name: 'Arch AI URLs',
          },
        };
      }

      if (path === '/api/search-ai/crawl/batch') {
        return {
          jobId: 'crawl-job-1',
          status: 'queued',
          success: true,
          received: body,
        };
      }

      throw new Error(`Unexpected POST ${path}`);
    });

    const result = await executeKBIngest(
      {
        action: 'add_url',
        kbId: 'kb-1',
        urls: ['https://example.com/docs/search'],
        metadata: { source: 'arch' },
      },
      makeCtx(),
      makeEnv(),
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        kbId: 'kb-1',
        kbName: 'Support KB',
        indexId: 'index-1',
        sourceId: 'source-urls',
        sourceName: 'Arch AI URLs',
        sourceType: 'web',
        sourceCreated: true,
        urls: ['https://example.com/docs/search'],
        warnings: ['Custom metadata is not attached to URL crawl jobs yet.'],
        jobId: 'crawl-job-1',
        status: 'queued',
      },
    });

    expect(clientPostMock).toHaveBeenNthCalledWith(
      2,
      '/api/search-ai/crawl/batch',
      expect.objectContaining({
        indexId: 'index-1',
        sourceId: 'source-urls',
        urls: ['https://example.com/docs/search'],
        strategy: 'single-page',
        options: {
          followLinks: false,
          useSitemap: false,
          maxPages: 1,
          extractMetadata: true,
        },
      }),
    );
  });
});

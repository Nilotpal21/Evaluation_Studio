import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadFilesError, uploadFiles } from '@/lib/arch/upload-files';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  authHeaders: () => ({
    Authorization: 'Bearer test-token',
  }),
}));

function createUploadSuccess(blobId: string, overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        blobId,
        metadata: {},
        tokenCost: 0,
        collision: false,
        ...overrides,
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function createStatusSuccess(blobId: string, status: string): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        blobId,
        name: 'brief.md',
        mediaType: 'text/markdown',
        size: 5,
        status,
        tokenCost: 2,
        metadata: { tokenEstimate: 2 },
        unavailableReason: null,
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

describe('uploadFiles', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes markdown files that browsers report as octet-stream', async () => {
    fetchMock.mockResolvedValueOnce(createUploadSuccess('blob-md'));

    const file = new File(['brief'], 'brief.md', { type: 'application/octet-stream' });

    await uploadFiles('session-1', [file]);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      file: { name: string; type: string };
    };
    expect(body.file).toMatchObject({
      name: 'brief.md',
      type: 'text/markdown',
    });
  });

  it('preserves the worker output MIME type when resized image bytes change format', async () => {
    class ResizeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      postMessage() {
        queueMicrotask(() => {
          this.onmessage?.({
            data: {
              type: 'resized',
              base64: 'ZmFrZQ==',
              width: 1200,
              height: 800,
              outputMimeType: 'image/jpeg',
            },
          } as MessageEvent);
        });
      }

      terminate() {}
    }

    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('Worker', ResizeWorker);
    fetchMock.mockResolvedValueOnce(createUploadSuccess('blob-image'));

    const file = new File(['fake'], 'diagram.webp', { type: 'image/webp' });

    await uploadFiles('session-1', [file]);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      file: { name: string; type: string };
    };
    expect(body.file).toMatchObject({
      name: 'diagram.webp',
      type: 'image/jpeg',
    });
  });

  it('surfaces route-specific upload errors and aborts the message send path', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'session_archived',
            message: 'Cannot operate on an archived session',
          },
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const file = new File(['brief'], 'brief.md', { type: 'text/markdown' });

    const error = await uploadFiles('session-1', [file]).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UploadFilesError);
    expect(error).toMatchObject({
      message:
        'Failed to upload "brief.md": Cannot operate on an archived session. Your message was not sent.',
      uploadedCount: 0,
      attemptedCount: 1,
      failures: [
        {
          fileName: 'brief.md',
          message: 'Cannot operate on an archived session',
          code: 'session_archived',
          status: 409,
        },
      ],
    });
  });

  it('parses shared errors envelopes returned by auth helpers', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 'FORBIDDEN', msg: 'No tenant context' }],
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const file = new File(['brief'], 'brief.md', { type: 'text/markdown' });

    const error = await uploadFiles('session-1', [file]).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UploadFilesError);
    expect(error).toMatchObject({
      message: 'Failed to upload "brief.md": No tenant context. Your message was not sent.',
      failures: [
        {
          fileName: 'brief.md',
          message: 'No tenant context',
          code: 'FORBIDDEN',
          status: 403,
        },
      ],
    });
  });

  it('stops after the first failed upload instead of silently sending a partial attachment set', async () => {
    fetchMock
      .mockResolvedValueOnce(createUploadSuccess('blob-1'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            error: {
              code: 'upload_failed',
              message: 'Storage backend unavailable',
            },
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const first = new File(['one'], 'one.txt', { type: 'text/plain' });
    const second = new File(['two'], 'two.txt', { type: 'text/plain' });
    const third = new File(['three'], 'three.txt', { type: 'text/plain' });

    const error = await uploadFiles('session-1', [first, second, third]).catch(
      (err: unknown) => err,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/arch-ai/files/blob-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
    expect(error).toBeInstanceOf(UploadFilesError);
    expect(error).toMatchObject({
      uploadedCount: 0,
      attemptedCount: 3,
      failures: [
        {
          fileName: 'two.txt',
          message: 'Storage backend unavailable',
          code: 'upload_failed',
          status: 500,
        },
      ],
    });
  });

  it('waits for multimodal processing before resolving immediate-send uploads', async () => {
    fetchMock
      .mockResolvedValueOnce(createUploadSuccess('blob-processing', { status: 'processing' }))
      .mockResolvedValueOnce(createStatusSuccess('blob-processing', 'processing'))
      .mockResolvedValueOnce(createStatusSuccess('blob-processing', 'active'));

    const file = new File(['brief'], 'brief.md', { type: 'text/markdown' });

    const [result] = await uploadFiles('session-1', [file], undefined, {
      waitForReady: true,
      readyPollIntervalMs: 1,
      readyTimeoutMs: 1000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/arch-ai/files/blob-processing',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
    expect(result).toMatchObject({
      blobId: 'blob-processing',
      status: 'active',
      tokenCost: 2,
      metadata: { tokenEstimate: 2 },
    });
  });

  it('fails immediate-send uploads when processing does not finish in time', async () => {
    fetchMock
      .mockResolvedValueOnce(createUploadSuccess('blob-stuck', { status: 'processing' }))
      .mockImplementation(() => Promise.resolve(createStatusSuccess('blob-stuck', 'processing')));

    const file = new File(['brief'], 'brief.md', { type: 'text/markdown' });

    const error = await uploadFiles('session-1', [file], undefined, {
      waitForReady: true,
      readyPollIntervalMs: 1,
      readyTimeoutMs: 3,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UploadFilesError);
    expect(error).toMatchObject({
      message:
        'Failed to upload "brief.md": The uploaded file is still being prepared. Try sending again in a moment. Your message was not sent.',
      failures: [
        {
          fileName: 'brief.md',
          message: 'The uploaded file is still being prepared. Try sending again in a moment',
          code: 'ATTACHMENT_PROCESSING_TIMEOUT',
        },
      ],
    });
  });
});

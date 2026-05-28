import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useComposerAttachments } from '@/lib/arch-ai/hooks/use-composer-attachments';
import { ARCH_AI_FILES } from '@/lib/arch-ai/constants';
import type {
  UploadResult,
  UploadedFileDetails,
  uploadFiles,
  fetchUploadedFile,
} from '@/lib/arch/upload-files';

type UploadFn = typeof uploadFiles;
type FetchFn = typeof fetchUploadedFile;

function makeUploadResult(blobId: string, status: UploadResult['status'] = 'active'): UploadResult {
  return {
    blobId,
    metadata: {},
    tokenCost: 0,
    collision: false,
    status,
  };
}

function makeFetchedDetails(
  blobId: string,
  status: UploadedFileDetails['status'] = 'active',
  overrides: Partial<UploadedFileDetails> = {},
): UploadedFileDetails {
  return {
    blobId,
    name: 'test.txt',
    mediaType: 'text/plain',
    size: 100,
    status,
    tokenCost: 0,
    metadata: {},
    unavailableReason: null,
    ...overrides,
  };
}

describe('useComposerAttachments', () => {
  it('uploads a file successfully and exposes it via readyBlobRefs', async () => {
    const mockUploadFiles: UploadFn = vi.fn(async (_sessionId, files, onProgress) => {
      onProgress?.(0, 1);
      return files.map((_, i) => makeUploadResult(`blob-${i + 1}`, 'active'));
    });
    const mockFetchUploadedFile: FetchFn = vi.fn(async (blobId) =>
      makeFetchedDetails(blobId, 'active'),
    );

    const { result } = renderHook(() =>
      useComposerAttachments({
        getSessionId: async () => 'sess-1',
        _uploadFiles: mockUploadFiles,
        _fetchUploadedFile: mockFetchUploadedFile,
      }),
    );

    await act(async () => {
      await result.current.handleComposerAttachFiles([
        new File(['content'], 'test.txt', { type: 'text/plain' }),
      ]);
    });

    await waitFor(() => {
      expect(result.current.composerAttachments[0]?.status).toBe('ready');
    });

    expect(result.current.composerAttachments[0]?.blobId).toBe('blob-1');
    expect(result.current.readyBlobRefs.length).toBe(1);
    expect(result.current.readyBlobRefs[0]).toEqual({
      blobId: 'blob-1',
      name: 'test.txt',
      type: 'text/plain',
      size: expect.any(Number),
    });
  });

  it('does not exceed MAX_FILES limit', async () => {
    let nextBlob = 0;
    const mockUploadFiles: UploadFn = vi.fn(async (_sessionId, files) =>
      files.map(() => makeUploadResult(`blob-${++nextBlob}`, 'active')),
    );
    const mockFetchUploadedFile: FetchFn = vi.fn(async (blobId) =>
      makeFetchedDetails(blobId, 'active'),
    );

    const { result } = renderHook(() =>
      useComposerAttachments({
        getSessionId: async () => 'sess-1',
        _uploadFiles: mockUploadFiles,
        _fetchUploadedFile: mockFetchUploadedFile,
      }),
    );

    const firstBatch = Array.from(
      { length: ARCH_AI_FILES.MAX_FILES },
      (_, i) => new File([`content-${i}`], `file-${i}.txt`, { type: 'text/plain' }),
    );

    await act(async () => {
      await result.current.handleComposerAttachFiles(firstBatch);
    });

    await waitFor(() => {
      expect(result.current.composerAttachments.length).toBe(ARCH_AI_FILES.MAX_FILES);
    });

    await act(async () => {
      await result.current.handleComposerAttachFiles([
        new File(['extra'], 'extra.txt', { type: 'text/plain' }),
      ]);
    });

    expect(result.current.composerAttachments.length).toBe(ARCH_AI_FILES.MAX_FILES);
  });

  it('marks attachment as failed when upload throws', async () => {
    const mockUploadFiles: UploadFn = vi.fn(async () => {
      throw new Error('Network error');
    });
    const mockFetchUploadedFile: FetchFn = vi.fn(async (blobId) =>
      makeFetchedDetails(blobId, 'active'),
    );

    const { result } = renderHook(() =>
      useComposerAttachments({
        getSessionId: async () => 'sess-1',
        _uploadFiles: mockUploadFiles,
        _fetchUploadedFile: mockFetchUploadedFile,
      }),
    );

    await act(async () => {
      await result.current.handleComposerAttachFiles([
        new File(['x'], 'fail.txt', { type: 'text/plain' }),
      ]);
    });

    await waitFor(() => {
      expect(result.current.composerAttachments[0]?.status).toBe('failed');
    });

    expect(result.current.composerAttachments[0]?.detail).toBe('Network error');
    expect(result.current.readyBlobRefs.length).toBe(0);
  });

  it('removeComposerAttachment removes the attachment with the given id', async () => {
    const mockUploadFiles: UploadFn = vi.fn(async (_sessionId, files) =>
      files.map((_, i) => makeUploadResult(`blob-${i + 1}`, 'active')),
    );
    const mockFetchUploadedFile: FetchFn = vi.fn(async (blobId) =>
      makeFetchedDetails(blobId, 'active'),
    );

    const { result } = renderHook(() =>
      useComposerAttachments({
        getSessionId: async () => 'sess-1',
        _uploadFiles: mockUploadFiles,
        _fetchUploadedFile: mockFetchUploadedFile,
      }),
    );

    await act(async () => {
      await result.current.handleComposerAttachFiles([
        new File(['content'], 'one.txt', { type: 'text/plain' }),
      ]);
    });

    await waitFor(() => {
      expect(result.current.composerAttachments[0]?.status).toBe('ready');
    });

    const idToRemove = result.current.composerAttachments[0]!.id;

    act(() => {
      result.current.removeComposerAttachment(idToRemove);
    });

    expect(result.current.composerAttachments.length).toBe(0);
  });

  it('clearComposerAttachments empties all attachments', async () => {
    let nextBlob = 0;
    const mockUploadFiles: UploadFn = vi.fn(async (_sessionId, files) =>
      files.map(() => makeUploadResult(`blob-${++nextBlob}`, 'active')),
    );
    const mockFetchUploadedFile: FetchFn = vi.fn(async (blobId) =>
      makeFetchedDetails(blobId, 'active'),
    );

    const { result } = renderHook(() =>
      useComposerAttachments({
        getSessionId: async () => 'sess-1',
        _uploadFiles: mockUploadFiles,
        _fetchUploadedFile: mockFetchUploadedFile,
      }),
    );

    await act(async () => {
      await result.current.handleComposerAttachFiles([
        new File(['a'], 'a.txt', { type: 'text/plain' }),
        new File(['b'], 'b.txt', { type: 'text/plain' }),
      ]);
    });

    await waitFor(() => {
      expect(result.current.composerAttachments.every((a) => a.status === 'ready')).toBe(true);
      expect(result.current.composerAttachments.length).toBe(2);
    });

    act(() => {
      result.current.clearComposerAttachments();
    });

    expect(result.current.composerAttachments.length).toBe(0);
  });
});

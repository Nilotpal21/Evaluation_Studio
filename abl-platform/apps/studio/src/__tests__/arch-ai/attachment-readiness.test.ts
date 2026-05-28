import { describe, expect, it, vi } from 'vitest';
import type { ArchFileStore, SessionFileRecord } from '@agent-platform/arch-ai/session';
import { validateArchFileRefsReady } from '@/lib/arch-ai/attachment-readiness';

function makeFile(overrides: Partial<SessionFileRecord> = {}): SessionFileRecord {
  return {
    _id: 'blob-1',
    name: 'guide.pdf',
    mediaType: 'application/pdf',
    size: 128,
    content: Buffer.from('ready'),
    metadata: { tokenEstimate: 10 },
    status: 'active',
    createdAt: new Date('2026-05-11T00:00:00.000Z'),
    resolvedText: 'ready',
    imageSource: null,
    unavailableReason: null,
    ...overrides,
  };
}

function makeFileStore(file: SessionFileRecord | Error): ArchFileStore {
  return {
    getByBlobId: vi.fn().mockImplementation(async () => {
      if (file instanceof Error) {
        throw file;
      }
      return file;
    }),
    getActiveFiles: vi.fn(),
    markFailed: vi.fn(),
  };
}

describe('validateArchFileRefsReady', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' };
  const sessionId = 'session-1';
  const fileRefs = [{ blobId: 'blob-1' }];

  it('allows active attachments', async () => {
    const result = await validateArchFileRefsReady({
      fileStore: makeFileStore(makeFile()),
      ctx,
      sessionId,
      fileRefs,
    });

    expect(result).toEqual({ ok: true });
  });

  it('returns a retryable conflict while processing is still running', async () => {
    const result = await validateArchFileRefsReady({
      fileStore: makeFileStore(
        makeFile({
          status: 'processing',
          unavailableReason: '[File still processing: guide.pdf]',
        }),
      ),
      ctx,
      sessionId,
      fileRefs,
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        status: 409,
        code: 'ATTACHMENT_STILL_PROCESSING',
        message:
          '"guide.pdf" is still being prepared. Please wait for the attachment to finish processing before sending.',
      },
    });
  });

  it('returns unavailable when processing failed', async () => {
    const result = await validateArchFileRefsReady({
      fileStore: makeFileStore(
        makeFile({
          status: 'failed',
          unavailableReason: 'Document parsing failed',
        }),
      ),
      ctx,
      sessionId,
      fileRefs,
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        status: 422,
        code: 'ATTACHMENT_UNAVAILABLE',
        message: 'Document parsing failed',
      },
    });
  });

  it('returns not found for unknown blob IDs', async () => {
    const result = await validateArchFileRefsReady({
      fileStore: makeFileStore(new Error('missing')),
      ctx,
      sessionId,
      fileRefs,
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        status: 404,
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'Attached file not found. Remove it and upload the file again.',
      },
    });
  });
});

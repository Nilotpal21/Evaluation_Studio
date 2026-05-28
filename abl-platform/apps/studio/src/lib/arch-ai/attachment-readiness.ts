import type { MessageRequest } from '@agent-platform/arch-ai';
import type { ArchFileStore, SessionContext } from '@agent-platform/arch-ai/session';

type FileRef = NonNullable<Extract<MessageRequest, { type: 'message' }>['fileRefs']>[number];

export interface AttachmentReadinessFailure {
  status: number;
  code: string;
  message: string;
}

export type AttachmentReadinessResult =
  | { ok: true }
  | { ok: false; failure: AttachmentReadinessFailure };

function formatFileLabel(name: string | undefined, fallback: string): string {
  return name && name.trim().length > 0 ? `"${name.trim()}"` : fallback;
}

export async function validateArchFileRefsReady(params: {
  fileStore: ArchFileStore;
  ctx: SessionContext;
  sessionId: string;
  fileRefs?: FileRef[];
}): Promise<AttachmentReadinessResult> {
  const { fileStore, ctx, sessionId, fileRefs } = params;
  if (!fileRefs || fileRefs.length === 0) {
    return { ok: true };
  }

  for (const ref of fileRefs) {
    try {
      const file = await fileStore.getByBlobId(ctx, sessionId, ref.blobId);
      const label = formatFileLabel(file.name, 'The attached file');

      if (file.status === 'processing') {
        return {
          ok: false,
          failure: {
            status: 409,
            code: 'ATTACHMENT_STILL_PROCESSING',
            message: `${label} is still being prepared. Please wait for the attachment to finish processing before sending.`,
          },
        };
      }

      if (file.status === 'failed' || file.status === 'blocked') {
        return {
          ok: false,
          failure: {
            status: 422,
            code: 'ATTACHMENT_UNAVAILABLE',
            message:
              file.unavailableReason ??
              `${label} could not be prepared. Remove it and upload the file again.`,
          },
        };
      }

      if (file.status === 'excluded' || file.status === 'evicted' || file.status === 'deleted') {
        return {
          ok: false,
          failure: {
            status: 410,
            code: 'ATTACHMENT_UNAVAILABLE',
            message: `${label} is no longer available. Remove it and upload the file again.`,
          },
        };
      }
    } catch {
      return {
        ok: false,
        failure: {
          status: 404,
          code: 'ATTACHMENT_NOT_FOUND',
          message: 'Attached file not found. Remove it and upload the file again.',
        },
      };
    }
  }

  return { ok: true };
}

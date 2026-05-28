import { useState, useCallback, useRef, useEffect } from 'react';
import {
  fetchUploadedFile,
  uploadFiles,
  type UploadedFileDetails,
  type UploadedFileStatus,
} from '@/lib/arch/upload-files';
import { ARCH_AI_FILES } from '@/lib/arch-ai/constants';
import {
  normalizeArchUploadMimeType,
  resolveAcceptedArchUploadMimeType,
} from '@/lib/arch-ai/file-mime';
import type { ChatInputAttachment } from '@/components/chat/ChatInputBar';

export interface ComposerAttachmentDraft extends ChatInputAttachment {
  blobId?: string;
  processingStartedAt?: number;
}

export interface ComposerBlobRef {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

interface UseComposerAttachmentsOptions {
  getSessionId: () => Promise<string | null>;
  // DI points for testing — default to real implementations in production
  _uploadFiles?: typeof uploadFiles;
  _fetchUploadedFile?: typeof fetchUploadedFile;
}

const ATTACHMENT_POLL_INTERVAL_MS = 1_500;

function mapUploadedFileStatus(
  status: UploadedFileStatus | undefined,
): ComposerAttachmentDraft['status'] {
  if (status === 'failed' || status === 'blocked') return 'failed';
  if (status === 'processing') return 'processing';
  return 'ready';
}

function buildAttachmentProcessingDetail(details: {
  mediaType: string;
  processingStartedAt?: number;
  now?: number;
}): string {
  if (details.processingStartedAt) {
    const elapsedMs = (details.now ?? Date.now()) - details.processingStartedAt;
    if (elapsedMs >= 90_000) return 'Still processing. You can wait or remove and upload it again.';
    if (elapsedMs >= 30_000) return 'Still extracting. Large PDFs and documents can take a minute.';
  }
  if (details.mediaType === 'application/pdf') return 'Extracting text from PDF...';
  if (
    details.mediaType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    details.mediaType.startsWith('text/')
  )
    return 'Extracting document text...';
  if (details.mediaType.startsWith('image/')) return 'Scanning image...';
  return 'Scanning and extracting content...';
}

function buildComposerAttachmentFromUpload(
  id: string,
  file: File,
  result: { blobId: string; status?: UploadedFileStatus },
): ComposerAttachmentDraft {
  const status = mapUploadedFileStatus(result.status);
  const mediaType = normalizeArchUploadMimeType(file.name, file.type);
  const processingStartedAt = status === 'processing' ? Date.now() : undefined;
  return {
    id,
    blobId: result.blobId,
    name: file.name,
    size: file.size,
    mediaType,
    status,
    processingStartedAt,
  };
}

function buildComposerAttachmentFromStatus(
  status: UploadedFileDetails,
  previous?: ComposerAttachmentDraft,
  now = Date.now(),
): ComposerAttachmentDraft {
  const mappedStatus = mapUploadedFileStatus(status.status);
  const processingStartedAt =
    mappedStatus === 'processing' ? (previous?.processingStartedAt ?? now) : undefined;
  return {
    id: status.blobId,
    blobId: status.blobId,
    name: status.name,
    size: status.size,
    mediaType: status.mediaType,
    status: mappedStatus,
    processingStartedAt,
    detail:
      mappedStatus === 'processing'
        ? buildAttachmentProcessingDetail({ mediaType: status.mediaType, processingStartedAt, now })
        : undefined,
  };
}

function validateAttachmentFile(file: File): { mediaType: string } | { error: string } {
  if (file.size <= 0) return { error: 'File is empty.' };
  if (file.size > ARCH_AI_FILES.MAX_FILE_SIZE_BYTES) {
    return {
      error: `File exceeds ${(ARCH_AI_FILES.MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0)}MB limit.`,
    };
  }
  const mediaType = resolveAcceptedArchUploadMimeType(file.name, file.type);
  if (!mediaType) {
    return {
      error: `Unsupported file type. Allowed: ${ARCH_AI_FILES.ACCEPTED_UPLOAD_EXTENSIONS.join(', ')}`,
    };
  }
  return { mediaType };
}

export function useComposerAttachments({
  getSessionId,
  _uploadFiles,
  _fetchUploadedFile,
}: UseComposerAttachmentsOptions) {
  const doUpload = _uploadFiles ?? uploadFiles;
  const doFetch = _fetchUploadedFile ?? fetchUploadedFile;

  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachmentDraft[]>([]);
  const attachmentsRef = useRef(composerAttachments);
  attachmentsRef.current = composerAttachments;

  const updateAttachment = useCallback(
    (id: string, updater: (c: ComposerAttachmentDraft) => ComposerAttachmentDraft) => {
      setComposerAttachments((prev) => prev.map((a) => (a.id === id ? updater(a) : a)));
    },
    [],
  );

  const removeComposerAttachment = useCallback((id: string) => {
    setComposerAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearComposerAttachments = useCallback(() => {
    setComposerAttachments([]);
  }, []);

  const handleComposerAttachFiles = useCallback(
    async (selectedFiles: File[]) => {
      if (selectedFiles.length === 0) return;

      const remainingSlots = Math.max(0, ARCH_AI_FILES.MAX_FILES - attachmentsRef.current.length);
      if (remainingSlots === 0) return;

      const existingKeys = new Set(
        attachmentsRef.current.map((a) => `${a.name}:${a.size}:${a.mediaType}`),
      );
      const accepted: Array<{ file: File; draft: ComposerAttachmentDraft }> = [];
      const rejected: ComposerAttachmentDraft[] = [];

      for (const file of selectedFiles) {
        const validation = validateAttachmentFile(file);
        const mediaType =
          'mediaType' in validation
            ? validation.mediaType
            : normalizeArchUploadMimeType(file.name, file.type);
        const key = `${file.name}:${file.size}:${mediaType}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);

        if ('error' in validation) {
          rejected.push({
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            mediaType,
            status: 'failed',
            detail: validation.error,
          });
        } else {
          accepted.push({
            file,
            draft: {
              id: crypto.randomUUID(),
              name: file.name,
              size: file.size,
              mediaType: validation.mediaType,
              status: 'uploading',
              progress: 0,
              detail: 'Uploading...',
            },
          });
        }

        if (accepted.length + rejected.length >= remainingSlots) break;
      }

      if (accepted.length === 0 && rejected.length === 0) return;

      const draftSlots = accepted.map((p) => p.draft);
      setComposerAttachments((prev) => [...prev, ...draftSlots, ...rejected]);

      if (accepted.length === 0) return;

      const sessionId = await getSessionId();
      if (!sessionId) {
        // Cannot upload without a session — mark all as failed
        setComposerAttachments((prev) =>
          prev.map((a) =>
            draftSlots.some((d) => d.id === a.id)
              ? { ...a, status: 'failed', progress: undefined, detail: 'No active session.' }
              : a,
          ),
        );
        return;
      }

      await Promise.all(
        accepted.map(async ({ draft, file }) => {
          try {
            const [result] = await doUpload(sessionId, [file], (_i, progress) => {
              updateAttachment(draft.id, (c) => ({
                ...c,
                progress,
                detail: progress >= 1 ? 'Preparing attachment...' : 'Uploading...',
              }));
            });
            updateAttachment(draft.id, () =>
              buildComposerAttachmentFromUpload(draft.id, file, result),
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            updateAttachment(draft.id, (c) => ({
              ...c,
              status: 'failed',
              progress: undefined,
              detail: message,
            }));
          }
        }),
      );
    },
    [getSessionId, doUpload, updateAttachment],
  );

  // Poll processing attachments until they become ready or failed
  const pendingBlobKey = composerAttachments
    .filter(
      (a): a is ComposerAttachmentDraft & { blobId: string } =>
        a.status === 'processing' && typeof a.blobId === 'string',
    )
    .map((a) => a.blobId)
    .sort()
    .join(',');

  useEffect(() => {
    if (pendingBlobKey === '') return;

    let cancelled = false;

    const poll = async () => {
      const now = Date.now();
      const pending = attachmentsRef.current.filter(
        (a): a is ComposerAttachmentDraft & { blobId: string } =>
          a.status === 'processing' && typeof a.blobId === 'string',
      );

      await Promise.all(
        pending.map(async (a) => {
          try {
            const latest = await doFetch(a.blobId);
            if (cancelled) return;
            setComposerAttachments((prev) =>
              prev.map((c) =>
                c.id === a.id
                  ? { ...buildComposerAttachmentFromStatus(latest, c, now), id: c.id }
                  : c,
              ),
            );
          } catch (err: unknown) {
            // Transient fetch failure — keep current state and retry next interval
            console.warn('[useComposerAttachments] poll fetch failed', {
              blobId: a.blobId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    };

    void poll();
    const timer = setInterval(() => void poll(), ATTACHMENT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingBlobKey, doFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  const readyBlobRefs: ComposerBlobRef[] = composerAttachments
    .filter(
      (a): a is ComposerAttachmentDraft & { blobId: string } =>
        a.status === 'ready' && typeof a.blobId === 'string',
    )
    .map((a) => ({ blobId: a.blobId, name: a.name, type: a.mediaType, size: a.size }));

  return {
    composerAttachments,
    handleComposerAttachFiles,
    removeComposerAttachment,
    clearComposerAttachments,
    readyBlobRefs,
  };
}

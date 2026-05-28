import type { Readable } from 'stream';
import { createLogger } from '@abl/compiler/platform';
import type { LineMediaReference, LineMediaDownloadResult } from './line-media-downloader.js';
import type { UploadResult } from '../../attachments/multimodal-service-client.js';
import { emitAttachmentTrace, type AttachmentTraceCallback } from './attachment-trace-utils.js';

const log = createLogger('line-media-processor');

export type LineMediaReferenceMetadata = LineMediaReference;

export interface ProcessOptions {
  accessToken: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  channel: string;
  provider?: string;
  onTraceEvent?: AttachmentTraceCallback;
  downloadFn: (ref: LineMediaReference, accessToken: string) => Promise<LineMediaDownloadResult>;
  uploadFn: (params: {
    stream: Readable;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    tenantId: string;
    projectId: string;
    sessionId: string;
    channel: string;
  }) => Promise<UploadResult>;
}

export async function processLineMediaReferences(
  mediaRefs: LineMediaReferenceMetadata[],
  options: ProcessOptions,
): Promise<string[]> {
  if (mediaRefs.length === 0) return [];

  const {
    accessToken,
    tenantId,
    projectId,
    sessionId,
    channel,
    provider,
    onTraceEvent,
    downloadFn,
    uploadFn,
  } = options;

  const results = await Promise.all(
    mediaRefs.map(async (ref) => {
      let stream: Readable | undefined;
      try {
        const download = await downloadFn(ref, accessToken);
        if (!download.success) {
          emitAttachmentTrace({
            onTraceEvent,
            type: 'attachment_process',
            channel,
            provider,
            stage: 'download',
            success: false,
            externalAttachmentId: ref.messageId,
            filename: ref.filename,
            mimeType: ref.mimeType,
            sizeBytes: ref.sizeBytes,
            error: download.error,
          });
          log.warn('Download failed', { messageId: ref.messageId, error: download.error });
          return null;
        }

        stream = download.stream;
        emitAttachmentTrace({
          onTraceEvent,
          type: 'attachment_process',
          channel,
          provider,
          stage: 'download',
          success: true,
          externalAttachmentId: ref.messageId,
          filename: download.filename,
          mimeType: download.mimeType,
          sizeBytes: download.sizeBytes,
        });

        const upload = await uploadFn({
          stream: download.stream,
          filename: download.filename,
          mimeType: download.mimeType,
          sizeBytes: download.sizeBytes,
          tenantId,
          projectId,
          sessionId,
          channel,
        });

        if (!upload.success) {
          if (stream && !stream.destroyed) {
            stream.destroy();
          }
          emitAttachmentTrace({
            onTraceEvent,
            type: 'attachment_upload',
            channel,
            provider,
            stage: 'upload',
            success: false,
            externalAttachmentId: ref.messageId,
            filename: download.filename,
            mimeType: download.mimeType,
            sizeBytes: download.sizeBytes,
            error: upload.error,
          });
          log.warn('Upload failed', { messageId: ref.messageId, error: upload.error });
          return null;
        }

        emitAttachmentTrace({
          onTraceEvent,
          type: 'attachment_upload',
          channel,
          provider,
          stage: 'upload',
          success: true,
          attachmentId: upload.attachmentId,
          externalAttachmentId: ref.messageId,
          filename: download.filename,
          mimeType: download.mimeType,
          sizeBytes: download.sizeBytes,
        });

        return upload.attachmentId;
      } catch (error) {
        if (stream && !stream.destroyed) {
          stream.destroy();
        }
        log.error('Error processing media', {
          messageId: ref.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );

  return results.filter((id): id is string => id !== null);
}

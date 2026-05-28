/**
 * Telegram Media Processor
 *
 * Orchestrates the download-then-upload flow for Telegram media attachments.
 * Each file is processed independently — individual failures don't block others.
 */

import type { Readable } from 'stream';
import { createLogger } from '@abl/compiler/platform';
import type {
  TelegramMediaReference,
  TelegramMediaDownloadResult,
} from './telegram-media-downloader.js';
import type { UploadResult } from '../../attachments/multimodal-service-client.js';
import { emitAttachmentTrace, type AttachmentTraceCallback } from './attachment-trace-utils.js';

const log = createLogger('telegram-media-processor');

export type TelegramMediaReferenceMetadata = TelegramMediaReference;

export interface ProcessOptions {
  botToken: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  channel: string;
  provider?: string;
  onTraceEvent?: AttachmentTraceCallback;
  downloadFn: (
    ref: TelegramMediaReference,
    botToken: string,
  ) => Promise<TelegramMediaDownloadResult>;
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

export async function processTelegramMediaReferences(
  mediaRefs: TelegramMediaReferenceMetadata[],
  options: ProcessOptions,
): Promise<string[]> {
  if (mediaRefs.length === 0) return [];

  const {
    botToken,
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
        const download = await downloadFn(ref, botToken);
        if (!download.success) {
          emitAttachmentTrace({
            onTraceEvent,
            type: 'attachment_process',
            channel,
            provider,
            stage: 'download',
            success: false,
            externalAttachmentId: ref.fileId,
            filename: ref.filename,
            mimeType: ref.mimeType,
            sizeBytes: ref.fileSize,
            error: download.error,
          });
          log.warn('Download failed', { mediaType: ref.mediaType, error: download.error });
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
          externalAttachmentId: ref.fileId,
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
            externalAttachmentId: ref.fileId,
            filename: download.filename,
            mimeType: download.mimeType,
            sizeBytes: download.sizeBytes,
            error: upload.error,
          });
          log.warn('Upload failed', { mediaType: ref.mediaType, error: upload.error });
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
          externalAttachmentId: ref.fileId,
          filename: download.filename,
          mimeType: download.mimeType,
          sizeBytes: download.sizeBytes,
        });

        return upload.attachmentId;
      } catch (err) {
        if (stream && !stream.destroyed) {
          stream.destroy();
        }
        log.error('Error processing media', {
          mediaType: ref.mediaType,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );

  return results.filter((id): id is string => id !== null);
}

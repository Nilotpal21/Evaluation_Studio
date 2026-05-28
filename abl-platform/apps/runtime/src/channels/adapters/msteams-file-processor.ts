/**
 * MS Teams File Processor
 *
 * Orchestrates download-then-upload for Teams file references.
 * Failures are isolated per file so text processing is never blocked.
 */

import type { Readable } from 'stream';
import { createLogger } from '@abl/compiler/platform';
import type { UploadResult } from '../../attachments/multimodal-service-client.js';
import type { MSTeamsFileReference, MSTeamsFileDownloadResult } from './msteams-file-downloader.js';
import { emitAttachmentTrace, type AttachmentTraceCallback } from './attachment-trace-utils.js';

const log = createLogger('msteams-file-processor');

export type MSTeamsFileReferenceMetadata = MSTeamsFileReference;

export interface ProcessOptions {
  tenantId: string;
  projectId: string;
  sessionId: string;
  channel: string;
  provider?: string;
  onTraceEvent?: AttachmentTraceCallback;
  botToken?: string;
  maxSizeBytes?: number;
  timeoutMs?: number;
  downloadFn: (
    ref: MSTeamsFileReference,
    options?: { botToken?: string; maxSizeBytes?: number; timeoutMs?: number },
  ) => Promise<MSTeamsFileDownloadResult>;
  uploadFn: (params: {
    stream: Readable;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    maxSizeBytes?: number;
    tenantId: string;
    projectId: string;
    sessionId: string;
    channel: string;
  }) => Promise<UploadResult>;
}

export async function processMSTeamsFileReferences(
  fileRefs: MSTeamsFileReferenceMetadata[],
  options: ProcessOptions,
): Promise<string[]> {
  if (fileRefs.length === 0) return [];

  const {
    tenantId,
    projectId,
    sessionId,
    channel,
    provider,
    onTraceEvent,
    botToken,
    maxSizeBytes,
    timeoutMs,
    downloadFn,
    uploadFn,
  } = options;

  const results = await Promise.all(
    fileRefs.map(async (ref) => {
      let stream: Readable | undefined;
      try {
        const download = await downloadFn(ref, {
          botToken,
          maxSizeBytes,
          timeoutMs,
        });
        if (!download.success) {
          emitAttachmentTrace({
            onTraceEvent,
            type: 'attachment_process',
            channel,
            provider,
            stage: 'download',
            success: false,
            externalAttachmentId: ref.uniqueId,
            filename: ref.name,
            mimeType: ref.mimeType,
            sizeBytes: ref.sizeBytes,
            error: download.error,
          });
          log.warn('Download failed', { filename: ref.name, error: download.error });
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
          externalAttachmentId: ref.uniqueId,
          filename: download.filename,
          mimeType: download.mimeType,
          sizeBytes: download.sizeBytes,
        });

        const upload = await uploadFn({
          stream: download.stream,
          filename: download.filename,
          mimeType: download.mimeType,
          sizeBytes: download.sizeBytes,
          maxSizeBytes,
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
            externalAttachmentId: ref.uniqueId,
            filename: download.filename,
            mimeType: download.mimeType,
            sizeBytes: download.sizeBytes,
            error: upload.error,
          });
          log.warn('Upload failed', { filename: ref.name, error: upload.error });
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
          externalAttachmentId: ref.uniqueId,
          filename: download.filename,
          mimeType: download.mimeType,
          sizeBytes: download.sizeBytes,
        });

        return upload.attachmentId;
      } catch (err) {
        if (stream && !stream.destroyed) {
          stream.destroy();
        }
        log.error('Error processing file', {
          filename: ref.name,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );

  return results.filter((id): id is string => id !== null);
}

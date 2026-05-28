/**
 * Instagram Media Processor
 *
 * Orchestrates the download-then-upload flow for Instagram media attachments.
 * Each file is processed independently — individual failures don't block others.
 */

import type { Readable } from 'stream';
import { createLogger } from '@abl/compiler/platform';
import type {
  InstagramMediaReference,
  InstagramMediaDownloadResult,
} from './instagram-media-downloader.js';
import type { UploadResult } from '../../attachments/multimodal-service-client.js';
import { emitAttachmentTrace, type AttachmentTraceCallback } from './attachment-trace-utils.js';

const log = createLogger('instagram-media-processor');

export type InstagramMediaReferenceMetadata = InstagramMediaReference;

export interface ProcessOptions {
  tenantId: string;
  projectId: string;
  sessionId: string;
  channel: string;
  provider?: string;
  onTraceEvent?: AttachmentTraceCallback;
  downloadFn: (ref: InstagramMediaReference) => Promise<InstagramMediaDownloadResult>;
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

export async function processInstagramMediaReferences(
  mediaRefs: InstagramMediaReferenceMetadata[],
  options: ProcessOptions,
): Promise<string[]> {
  if (mediaRefs.length === 0) return [];

  const { tenantId, projectId, sessionId, channel, provider, onTraceEvent, downloadFn, uploadFn } =
    options;

  const results = await Promise.all(
    mediaRefs.map(async (ref) => {
      let stream: Readable | undefined;
      try {
        const download = await downloadFn(ref);
        if (!download.success) {
          emitAttachmentTrace({
            onTraceEvent,
            type: 'attachment_process',
            channel,
            provider,
            stage: 'download',
            success: false,
            error: download.error,
          });
          log.warn('Download failed', { type: ref.type, error: download.error });
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
            filename: download.filename,
            mimeType: download.mimeType,
            sizeBytes: download.sizeBytes,
            error: upload.error,
          });
          log.warn('Upload failed', { type: ref.type, error: upload.error });
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
          filename: download.filename,
          mimeType: download.mimeType,
          sizeBytes: download.sizeBytes,
        });

        return upload.attachmentId;
      } catch (err) {
        // Ensure stream is destroyed on failure to prevent file descriptor leaks
        if (stream && !stream.destroyed) {
          stream.destroy();
        }
        log.error('Error processing media', {
          type: ref.type,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );

  return results.filter((id): id is string => id !== null);
}

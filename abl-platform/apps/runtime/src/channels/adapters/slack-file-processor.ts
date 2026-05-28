/**
 * Slack File Processor
 *
 * Orchestrates the download-then-upload flow for Slack file attachments.
 * Each file is processed independently — individual failures don't block others.
 */

import type { Readable } from 'stream';
import type { SlackFileReference, SlackFileDownloadResult } from './slack-file-downloader.js';
import type { UploadResult } from '../../attachments/multimodal-service-client.js';
import { createLogger } from '@abl/compiler/platform';
import { emitAttachmentTrace, type AttachmentTraceCallback } from './attachment-trace-utils.js';

const log = createLogger('slack-file-processor');

export type SlackFileReferenceMetadata = SlackFileReference;

export interface ProcessOptions {
  botToken: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  channel: string;
  provider?: string;
  onTraceEvent?: AttachmentTraceCallback;
  /** Injectable for testing — defaults to downloadSlackFile */
  downloadFn?: (ref: SlackFileReference, token: string) => Promise<SlackFileDownloadResult>;
  /** Injectable for testing — defaults to MultimodalServiceClient.upload() */
  uploadFn?: (params: {
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

/**
 * Process Slack file references: download from Slack CDN, upload to multimodal-service.
 * Returns an array of attachment IDs for successfully processed files.
 * Never throws — individual file failures are logged and skipped.
 */
export async function processSlackFileReferences(
  fileRefs: SlackFileReferenceMetadata[],
  options: ProcessOptions,
): Promise<string[]> {
  if (fileRefs.length === 0) return [];

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
    fileRefs.map(async (ref) => {
      const startTime = Date.now();
      let currentStage: 'download' | 'upload' = 'download';
      let resolvedFilename = ref.name;
      let resolvedMimeType = ref.mimetype;
      let resolvedSizeBytes = ref.size;

      try {
        // 1. Download from Slack
        const download = await downloadFn!(ref, botToken);
        if (!download.success) {
          emitAttachmentTrace({
            onTraceEvent,
            type: 'attachment_process',
            channel,
            provider,
            stage: 'download',
            success: false,
            externalAttachmentId: ref.slackFileId,
            filename: ref.name,
            mimeType: ref.mimetype,
            sizeBytes: ref.size,
            error: download.error,
          });
          log.warn('Download failed for Slack file', {
            filename: ref.name,
            slackFileId: ref.slackFileId,
            error: download.error,
            downloadFailure: download.details,
          });
          return null;
        }

        emitAttachmentTrace({
          onTraceEvent,
          type: 'attachment_process',
          channel,
          provider,
          stage: 'download',
          success: true,
          externalAttachmentId: ref.slackFileId,
          filename: download.filename,
          mimeType: download.mimeType,
          sizeBytes: download.sizeBytes,
        });

        // 2. Upload to multimodal-service
        currentStage = 'upload';
        resolvedFilename = download.filename;
        resolvedMimeType = download.mimeType;
        resolvedSizeBytes = download.sizeBytes;
        const upload = await uploadFn!({
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
          emitAttachmentTrace({
            onTraceEvent,
            type: 'attachment_upload',
            channel,
            provider,
            stage: 'upload',
            success: false,
            externalAttachmentId: ref.slackFileId,
            filename: download.filename,
            mimeType: download.mimeType,
            sizeBytes: download.sizeBytes,
            error: upload.error,
          });
          log.warn('Upload failed for Slack file', { filename: ref.name, error: upload.error });
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
          externalAttachmentId: ref.slackFileId,
          filename: download.filename,
          mimeType: download.mimeType,
          sizeBytes: download.sizeBytes,
        });

        return upload.attachmentId;
      } catch (err) {
        emitAttachmentTrace({
          onTraceEvent,
          type: currentStage === 'upload' ? 'attachment_upload' : 'attachment_process',
          channel,
          provider,
          stage: currentStage,
          success: false,
          durationMs: Date.now() - startTime,
          externalAttachmentId: ref.slackFileId,
          filename: resolvedFilename,
          mimeType: resolvedMimeType,
          sizeBytes: resolvedSizeBytes,
          error: err,
        });
        log.error('Error processing Slack file', {
          filename: ref.name,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );

  return results.filter((id): id is string => id !== null);
}

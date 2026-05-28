/**
 * Email Attachment Processor
 *
 * Uploads email attachments (already available as Buffers from mailparser)
 * to the multimodal service. Each file is processed independently —
 * individual failures don't block others.
 */

import { Readable } from 'node:stream';
import { createLogger } from '@abl/compiler/platform';
import type { UploadResult } from '../../attachments/multimodal-service-client.js';
import { emitAttachmentTrace, type AttachmentTraceCallback } from './attachment-trace-utils.js';

const log = createLogger('email-attachment-processor');

/** Maximum size per attachment (20 MB). */
const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;

/** Maximum concurrent uploads to multimodal service. */
const UPLOAD_CONCURRENCY = 5;

export interface EmailAttachmentRef {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
}

export interface EmailProcessOptions {
  tenantId: string;
  projectId: string;
  sessionId: string;
  channel: string;
  provider?: string;
  onTraceEvent?: AttachmentTraceCallback;
  /** Upload function — inject MultimodalServiceClient.upload() or a test stub */
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

/**
 * Process email attachments: convert Buffers to streams and upload to multimodal-service.
 * Returns an array of attachment IDs for successfully processed files.
 * Never throws — individual file failures are logged and skipped.
 */
export async function processEmailAttachments(
  attachments: EmailAttachmentRef[],
  options: EmailProcessOptions,
): Promise<string[]> {
  if (attachments.length === 0) return [];

  const { tenantId, projectId, sessionId, channel, provider, onTraceEvent, uploadFn } = options;

  const allResults: (string | null)[] = [];

  // Process in batches to limit concurrent uploads
  for (let i = 0; i < attachments.length; i += UPLOAD_CONCURRENCY) {
    const batch = attachments.slice(i, i + UPLOAD_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (att) => {
        try {
          if (att.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
            emitAttachmentTrace({
              onTraceEvent,
              type: 'attachment_upload',
              channel,
              provider,
              stage: 'validate',
              success: false,
              filename: att.filename,
              mimeType: att.mimeType,
              sizeBytes: att.sizeBytes,
              error: `File exceeds max size (${MAX_ATTACHMENT_SIZE_BYTES} bytes)`,
            });
            log.warn('Email attachment exceeds size limit, skipping', {
              filename: att.filename,
              sizeBytes: att.sizeBytes,
              maxBytes: MAX_ATTACHMENT_SIZE_BYTES,
            });
            return null;
          }

          const stream = Readable.from(att.content);

          const upload = await uploadFn({
            stream,
            filename: att.filename,
            mimeType: att.mimeType,
            sizeBytes: att.sizeBytes,
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
              filename: att.filename,
              mimeType: att.mimeType,
              sizeBytes: att.sizeBytes,
              error: upload.error,
            });
            log.warn('Upload failed for email attachment', {
              filename: att.filename,
              error: upload.error,
            });
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
            filename: att.filename,
            mimeType: att.mimeType,
            sizeBytes: att.sizeBytes,
          });

          return upload.attachmentId;
        } catch (err) {
          log.error('Error processing email attachment', {
            filename: att.filename,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }),
    );
    allResults.push(...batchResults);
  }

  return allResults.filter((id): id is string => id !== null);
}

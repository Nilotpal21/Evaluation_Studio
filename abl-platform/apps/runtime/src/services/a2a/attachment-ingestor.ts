import { Readable } from 'node:stream';
import { createLogger } from '@abl/compiler/platform';
import type {
  A2AAttachment,
  A2AAttachmentIngestRequest,
  A2AAttachmentIngestor,
} from '@agent-platform/a2a';
import {
  MultimodalServiceClient,
  type UploadParams,
  type UploadResult,
} from '../../attachments/multimodal-service-client.js';
import {
  resolveAttachmentConfig,
  type ResolvedAttachmentConfig,
} from '../../attachments/attachment-config-resolver.js';
import {
  buildMultimodalUploadConfig,
  mimeTypeMatchesAllowed,
  normalizeUploadMimeType,
} from '../../attachments/multimodal-upload-config.js';

const log = createLogger('a2a-attachment-ingestor');

const DEFAULT_FILENAME_PREFIX = 'a2a-file';
const DEFAULT_MIME_TYPE = 'application/octet-stream';

interface NormalizedAttachmentUpload {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface CreateA2AAttachmentIngestorDeps {
  resolveConfigFn?: (tenantId: string, projectId: string) => Promise<ResolvedAttachmentConfig>;
  uploadFn?: (params: UploadParams) => Promise<UploadResult>;
}

function decodeDataUri(uri: string): { buffer: Buffer; mimeType?: string } | null {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(uri);
  if (!match) {
    return null;
  }

  try {
    return {
      buffer: Buffer.from(match[2], 'base64'),
      mimeType: match[1],
    };
  } catch (err) {
    log.warn('Failed to decode A2A data URI attachment', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function normalizeAttachmentForUpload(
  attachment: A2AAttachment,
  index: number,
): NormalizedAttachmentUpload | null {
  if (attachment.bytes) {
    try {
      const buffer = Buffer.from(attachment.bytes, 'base64');
      if (buffer.length === 0) {
        log.warn('Skipping empty A2A inline attachment bytes', {
          name: attachment.name,
          index,
        });
        return null;
      }

      return {
        buffer,
        filename: attachment.name || `${DEFAULT_FILENAME_PREFIX}-${index + 1}`,
        mimeType: attachment.mimeType || DEFAULT_MIME_TYPE,
        sizeBytes: buffer.length,
      };
    } catch (err) {
      log.warn('Failed to decode A2A inline attachment bytes', {
        name: attachment.name,
        index,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  if (attachment.uri?.startsWith('data:')) {
    const decoded = decodeDataUri(attachment.uri);
    if (!decoded || decoded.buffer.length === 0) {
      log.warn('Skipping invalid A2A data URI attachment', {
        name: attachment.name,
        index,
      });
      return null;
    }

    return {
      buffer: decoded.buffer,
      filename: attachment.name || `${DEFAULT_FILENAME_PREFIX}-${index + 1}`,
      mimeType: attachment.mimeType || decoded.mimeType || DEFAULT_MIME_TYPE,
      sizeBytes: decoded.buffer.length,
    };
  }

  if (attachment.uri) {
    log.warn('Skipping A2A URI attachment without inline bytes', {
      name: attachment.name,
      index,
      uri: attachment.uri,
    });
  }

  return null;
}

export function createA2AAttachmentIngestor(
  deps: CreateA2AAttachmentIngestorDeps = {},
): A2AAttachmentIngestor {
  const resolveConfigFn = deps.resolveConfigFn ?? resolveAttachmentConfig;
  const uploadFn =
    deps.uploadFn ??
    ((params: UploadParams) => {
      const client = new MultimodalServiceClient();
      return client.upload(params);
    });

  return async function ingestA2AAttachments(
    params: A2AAttachmentIngestRequest,
  ): Promise<string[]> {
    const { attachments, sessionId, context } = params;
    if (attachments.length === 0) {
      return [];
    }

    const attachmentConfig = await resolveConfigFn(context.tenantId, context.projectId);
    if (!attachmentConfig.enabled) {
      log.info('Skipping A2A attachment ingestion because attachments are disabled', {
        sessionId,
        tenantId: context.tenantId,
        projectId: context.projectId,
      });
      return [];
    }

    const limitedAttachments =
      attachments.length > attachmentConfig.maxFilesPerSession
        ? attachments.slice(0, attachmentConfig.maxFilesPerSession)
        : attachments;

    if (limitedAttachments.length < attachments.length) {
      log.warn('Skipping excess A2A attachments beyond session limit', {
        sessionId,
        attachmentCount: attachments.length,
        maxFilesPerSession: attachmentConfig.maxFilesPerSession,
      });
    }

    const attachmentIds: string[] = [];

    for (const [index, attachment] of limitedAttachments.entries()) {
      const normalized = normalizeAttachmentForUpload(attachment, index);
      if (!normalized) {
        continue;
      }
      const mimeType = normalizeUploadMimeType(normalized.filename, normalized.mimeType);

      if (normalized.sizeBytes > attachmentConfig.maxFileSizeBytes) {
        log.warn('Skipping A2A attachment that exceeds size limit', {
          sessionId,
          filename: normalized.filename,
          sizeBytes: normalized.sizeBytes,
          maxFileSizeBytes: attachmentConfig.maxFileSizeBytes,
        });
        continue;
      }

      if (
        attachmentConfig.allowedMimeTypes.length > 0 &&
        !mimeTypeMatchesAllowed(mimeType, attachmentConfig.allowedMimeTypes)
      ) {
        log.warn('Skipping A2A attachment with disallowed MIME type', {
          sessionId,
          filename: normalized.filename,
          mimeType,
        });
        continue;
      }

      const upload = await uploadFn({
        stream: Readable.from(normalized.buffer),
        filename: normalized.filename,
        mimeType,
        sizeBytes: normalized.sizeBytes,
        maxSizeBytes: attachmentConfig.maxFileSizeBytes,
        tenantId: context.tenantId,
        projectId: context.projectId,
        sessionId,
        channel: 'a2a',
        config: buildMultimodalUploadConfig(attachmentConfig),
      });

      if (!upload.success) {
        log.warn('Failed to upload A2A attachment', {
          sessionId,
          filename: normalized.filename,
          error: upload.error,
        });
        continue;
      }

      attachmentIds.push(upload.attachmentId);
    }

    return attachmentIds;
  };
}

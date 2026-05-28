/**
 * MessagePreprocessor
 *
 * Adapter between the attachment service and the runtime engine.
 * Called BEFORE engine.processMessage() to transform attachments
 * into ContentBlock[] for the LLM.
 *
 * Uses MultimodalServiceClient (HTTP client) to fetch attachment
 * metadata and attachment content from the multimodal-service.
 */
import type { IAttachment } from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';
import type { ContentBlock, ImageContent } from '@abl/compiler/platform/llm/types.js';
import type { MultimodalServiceClient } from './multimodal-service-client.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum characters of processedContent to inject into LLM prompt. ~12k tokens. */
const MAX_PROCESSED_CONTENT_CHARS = 50_000;

const log = createLogger('message-preprocessor');

/** PII handling policy for attachment content before LLM injection. */
export type PIIPolicy = 'redact' | 'block' | 'allow';

function hasSafeDetectionPreview(value: string): boolean {
  return value.startsWith('[REDACTED');
}

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface RawIncomingMessage {
  content: string;
  attachmentIds: string[];
  channel: string;
}

export interface EngineReadyMessage {
  /** Original text + prepended attachment text */
  content: string;
  /** Includes ImageContent for images, TextContent for final message */
  contentBlocks: ContentBlock[];
  metadata: {
    /** Preserved for tracing */
    attachmentIds: string[];
    /** Human-readable summary, e.g. "2 images, 1 PDF" */
    attachmentSummary: string;
  };
}

export interface PreprocessParams {
  message: RawIncomingMessage;
  tenantId: string;
  /** Optional: pre-fetched attachments. If not provided, fetches via client using attachmentIds. */
  attachments?: IAttachment[];
  /** PII handling policy. Defaults to 'redact' if not provided. */
  piiPolicy?: PIIPolicy;
  /** Whether the resolved model supports vision. Defaults to false. */
  supportsVision?: boolean;
  /** Max video frames to send as vision blocks. Defaults to 5. */
  maxVideoFrames?: number;
}

// ─── Implementation ─────────────────────────────────────────────────────────

export class MessagePreprocessor {
  private readonly client: MultimodalServiceClient;

  constructor(client: MultimodalServiceClient) {
    this.client = client;
  }

  async preprocess(params: PreprocessParams): Promise<EngineReadyMessage> {
    const {
      message,
      tenantId,
      attachments: providedAttachments,
      piiPolicy,
      supportsVision = false,
      maxVideoFrames = 5,
    } = params;
    const effectivePolicy: PIIPolicy = piiPolicy ?? 'redact';

    // If no attachment IDs, return message as-is
    if (!message.attachmentIds.length) {
      return {
        content: message.content,
        contentBlocks: [{ type: 'text', text: message.content }],
        metadata: { attachmentIds: [], attachmentSummary: '' },
      };
    }

    // Fetch attachments if not pre-provided
    const attachments =
      providedAttachments ?? (await this.fetchAttachments(message.attachmentIds, tenantId));

    // Build content blocks and prepended text
    const contentBlocks: ContentBlock[] = [];
    const prependedParts: string[] = [];

    for (const attachment of attachments) {
      // Skip LLM injection for non-full processing modes
      const mode = (attachment as IAttachment & { processingMode?: string }).processingMode;
      if (mode && mode !== 'full') {
        const safeName = sanitizeFilename(attachment.originalFilename);
        prependedParts.push(`[File stored (${mode}): ${safeName} — not processed for LLM]`);
        continue;
      }

      await this.transformAttachment(
        attachment,
        tenantId,
        contentBlocks,
        prependedParts,
        effectivePolicy,
        supportsVision,
        maxVideoFrames,
      );
    }

    // Build final content: prepended text + original message
    const finalContent =
      prependedParts.length > 0
        ? prependedParts.join('\n') + '\n\n' + message.content
        : message.content;

    // Always include the text content block
    contentBlocks.push({ type: 'text', text: finalContent });

    // Build summary
    const summary = this.buildSummary(attachments);

    return {
      content: finalContent,
      contentBlocks,
      metadata: {
        attachmentIds: message.attachmentIds,
        attachmentSummary: summary,
      },
    };
  }

  // ── Private Methods ─────────────────────────────────────────────────────

  /**
   * Fetch individual attachments via HTTP client.
   * Filters out nulls (not found / network errors).
   */
  private async fetchAttachments(ids: string[], tenantId: string): Promise<IAttachment[]> {
    const results = await Promise.all(ids.map((id) => this.client.getAttachment(id, tenantId)));
    return results.filter((a): a is IAttachment => a !== null);
  }

  /**
   * Transform a single attachment into content blocks / prepended text
   * according to the transformation rules (Design Doc section 8.2 & 8.3).
   */
  private async transformAttachment(
    attachment: IAttachment,
    tenantId: string,
    contentBlocks: ContentBlock[],
    prependedParts: string[],
    piiPolicy: PIIPolicy,
    supportsVision: boolean,
    maxVideoFrames: number,
  ): Promise<void> {
    const safeName = sanitizeFilename(attachment.originalFilename);

    // Block infected or unscanned files from reaching the LLM
    if (attachment.scanStatus === 'infected') {
      prependedParts.push(`[File blocked: ${safeName} — security scan failed]`);
      return;
    }
    if (attachment.scanStatus === 'pending' || attachment.scanStatus === 'error') {
      prependedParts.push(`[File unavailable: ${safeName} — security scan incomplete]`);
      return;
    }

    // For images, the LLM can use the original file regardless of processing status.
    // Processing (resize/thumbnail) is for storage optimization, not LLM consumption.
    // Skip the processing status checks and go straight to image handling.
    if (attachment.category === 'image') {
      // Fall through to the image case in the switch below
    } else {
      // Handle non-completed processing statuses for non-image attachments
      if (
        attachment.processingStatus === 'processing' ||
        attachment.processingStatus === 'pending'
      ) {
        prependedParts.push(`[File still processing: ${safeName}]`);
        return;
      }

      if (attachment.processingStatus === 'failed') {
        const errorDetail = attachment.processingError ?? 'Unknown error';
        prependedParts.push(`[Failed to process: ${safeName} — ${errorDetail}]`);
        return;
      }

      if (attachment.processingStatus === 'skipped') {
        prependedParts.push(`[Unsupported file: ${safeName}]`);
        return;
      }
    }

    // processingStatus === 'completed' (or image with any status)
    switch (attachment.category) {
      case 'image': {
        // Skip download entirely if model doesn't support vision
        if (!supportsVision) {
          prependedParts.push(
            `[Image attached: ${safeName}${attachment.resizedSizeBytes ? `, ${attachment.mimeType}` : ''} — this model does not support image analysis]`,
          );
          break;
        }

        // Prefer resized variant (max 2048px) over original to avoid 20MB+ base64 payloads
        const imageContent = attachment.resizedStorageKey
          ? await this.client.downloadResizedContent(attachment._id, tenantId)
          : await this.client.downloadAttachmentContent(attachment._id, tenantId);

        if (!imageContent) {
          // User-visible feedback instead of silent drop
          prependedParts.push(`[Image could not be loaded: ${safeName}]`);
          log.warn('Failed to download image attachment content for LLM injection', {
            attachmentId: attachment._id,
            tenantId,
          });
          break;
        }

        contentBlocks.push(
          imageBytesToContent(imageContent.content, attachment, imageContent.contentType),
        );
        break;
      }
      case 'document': {
        const content = applyPIIPolicy(attachment, piiPolicy, safeName);
        if (content) {
          prependedParts.push(`[Attached document: ${safeName}]\n${content}`);
        }
        break;
      }
      case 'audio': {
        const content = applyPIIPolicy(attachment, piiPolicy, safeName);
        if (content) {
          prependedParts.push(`[Attached audio: ${safeName}]\n${content}`);
        }
        break;
      }
      case 'video': {
        // Always include transcript text
        const content = applyPIIPolicy(attachment, piiPolicy, safeName);
        if (content) {
          prependedParts.push(`[Attached video: ${safeName}]\n${content}`);
        }

        // If model supports vision and frames exist, inject as ImageContent[]
        if (supportsVision && (attachment.frameStorageKeys?.length ?? 0) > 0) {
          const frameBlocks = await this.resolveVideoFrames(attachment, tenantId, maxVideoFrames);
          contentBlocks.push(...frameBlocks);
          if (frameBlocks.length > 0) {
            log.info('Video frames injected as vision blocks', {
              attachmentId: attachment._id,
              frameCount: frameBlocks.length,
            });
          }
        }
        break;
      }
      default: {
        const _exhaustiveCheck: never = attachment.category;
        log.warn('Unknown attachment category', { category: _exhaustiveCheck });
        prependedParts.push(`[Unsupported attachment type: ${safeName}]`);
      }
    }
  }

  /**
   * Download video frames in parallel, convert to ImageContent[] blocks.
   * Uses Promise.allSettled for partial success — if 3/5 frames download,
   * those 3 are returned (not all-or-nothing).
   */
  private async resolveVideoFrames(
    attachment: IAttachment,
    tenantId: string,
    maxFrames: number,
  ): Promise<ImageContent[]> {
    const frameKeys = attachment.frameStorageKeys ?? [];
    if (frameKeys.length === 0) return [];

    const framesToFetch = Math.min(frameKeys.length, maxFrames);
    const results = await Promise.allSettled(
      Array.from({ length: framesToFetch }, (_, i) =>
        this.client.downloadFrameContent(attachment._id, tenantId, i),
      ),
    );

    const imageBlocks: ImageContent[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        imageBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: (result.value.contentType || 'image/png') as
              | 'image/png'
              | 'image/jpeg'
              | 'image/webp'
              | 'image/gif',
            data: result.value.content.toString('base64'),
          },
          attachmentId: attachment._id,
        });
      } else {
        log.warn('Video frame download failed', {
          attachmentId: attachment._id,
          frameIndex: i,
          reason:
            result.status === 'rejected'
              ? result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
              : 'null response',
        });
      }
    }

    return imageBlocks;
  }

  /**
   * Build a human-readable summary like "2 images, 1 document".
   * Uses singular/plural form based on count.
   */
  private buildSummary(attachments: IAttachment[]): string {
    const counts: Record<string, number> = {};
    for (const att of attachments) {
      counts[att.category] = (counts[att.category] ?? 0) + 1;
    }
    const parts: string[] = [];
    for (const [category, count] of Object.entries(counts)) {
      parts.push(`${count} ${category}${count > 1 ? 's' : ''}`);
    }
    return parts.join(', ');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip newlines and control characters from filenames to prevent
 * prompt injection via crafted filenames.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n\t]/g, ' ').trim();
}

/**
 * Truncate processedContent to MAX_PROCESSED_CONTENT_CHARS to prevent
 * oversized payloads from bloating the LLM context window.
 * Returns null if content is null or empty.
 */
function truncateContent(content: string | null): string | null {
  if (!content) return null;
  if (content.length <= MAX_PROCESSED_CONTENT_CHARS) return content;
  return content.slice(0, MAX_PROCESSED_CONTENT_CHARS) + '\n[... truncated]';
}

/**
 * Apply PII policy to attachment content before LLM injection.
 *
 * - 'redact': Replace PII tokens with [REDACTED:type] using stored piiDetections
 * - 'block': Return block message instead of content
 * - 'allow': Return raw content (current behavior)
 *
 * Falls back to truncateContent when no PII is present.
 */
function applyPIIPolicy(
  attachment: IAttachment,
  policy: PIIPolicy,
  safeName: string,
): string | null {
  const content = truncateContent(attachment.processedContent);
  if (!content) return null;

  // No PII flagged — pass through verbatim
  if (!attachment.hasPII) {
    return content;
  }

  switch (policy) {
    case 'allow':
      return content;

    case 'block':
      log.info('PII block policy applied', {
        attachmentId: attachment._id,
        filename: safeName,
      });
      return '[File contains PII and cannot be processed]';

    case 'redact': {
      const detections =
        (
          attachment as IAttachment & {
            piiDetections?: { type: string; start: number; end: number; value: string }[];
          }
        ).piiDetections ?? [];
      if (detections.length === 0) {
        // hasPII is true but no detections stored — block as safety fallback
        return content;
      }

      // Sort detections by start position descending to safely replace from end.
      // Older attachments stored raw substrings in `value`; newer detectors can
      // persist a safe preview instead (for example `[REDACTED_EMAIL]`).
      // Use offsets as the source of truth when the stored value is already
      // sanitized, while still guarding against out-of-bounds spans.
      const sorted = [...detections].sort((a, b) => b.start - a.start);
      let redacted = content;
      for (const det of sorted) {
        if (det.start < 0 || det.end > redacted.length || det.start >= det.end) {
          continue;
        }

        const actualValue = redacted.substring(det.start, det.end);
        if (actualValue === det.value || hasSafeDetectionPreview(det.value)) {
          redacted =
            redacted.substring(0, det.start) +
            `[REDACTED:${det.type}]` +
            redacted.substring(det.end);
        }
      }

      log.info('PII redaction applied', {
        attachmentId: attachment._id,
        filename: safeName,
        redactedCount: detections.length,
      });

      return redacted;
    }

    default:
      return content;
  }
}

function imageBytesToContent(
  buffer: Buffer,
  attachment: IAttachment,
  actualContentType?: string,
): ImageContent {
  const base64 = buffer.toString('base64');
  const mediaType = actualContentType || attachment.mimeType || 'image/png';
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: base64 },
    attachmentId: attachment._id,
  };
}

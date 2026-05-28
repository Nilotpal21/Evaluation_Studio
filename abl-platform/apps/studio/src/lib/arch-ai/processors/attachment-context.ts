import { createLogger } from '@abl/compiler/platform/logger.js';
import type { ArchContentBlock } from '@agent-platform/arch-ai';
import { fileStoreService } from '@/lib/arch-ai/message-services';

const log = createLogger('lib:arch-ai:processors:attachment-context');

const MAX_FILE_CONTEXT_CHARS = 8_000;
const MAX_TOTAL_FILE_CONTEXT_CHARS = 20_000;
const MAX_FILE_SUMMARY_CHARS = 2_000;

interface ProcessorContext {
  tenantId: string;
  userId: string;
}

interface FileRef {
  blobId: string;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[Attachment truncated for model context]`;
}

function resolveAttachmentText(file: {
  content: Buffer;
  mediaType: string;
  name: string;
  resolvedText?: string | null;
  unavailableReason?: string | null;
}): string {
  if (file.mediaType.startsWith('image/')) {
    return `[Attached image: ${file.name}]`;
  }

  const rawText =
    typeof file.resolvedText === 'string' && file.resolvedText.length > 0
      ? file.resolvedText
      : file.content.toString('utf-8');

  if (rawText.trim().length > 0) {
    return `[Attached file: ${file.name}]\n${rawText}\n[/Attached file]`;
  }

  if (file.unavailableReason) {
    return `[Attached file unavailable: ${file.name} — ${file.unavailableReason}]`;
  }

  return `[Attached file: ${file.name}]`;
}

function summarizeAttachmentText(file: {
  content: Buffer;
  mediaType: string;
  name: string;
  resolvedText?: string | null;
  unavailableReason?: string | null;
}): string | undefined {
  if (file.mediaType.startsWith('image/')) {
    return undefined;
  }

  if (file.unavailableReason) {
    return file.unavailableReason;
  }

  const rawText =
    typeof file.resolvedText === 'string' && file.resolvedText.length > 0
      ? file.resolvedText
      : file.content.toString('utf-8');

  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return truncateText(trimmed, MAX_FILE_SUMMARY_CHARS);
}

export async function buildUserContentFromFileRefs(
  ctx: ProcessorContext,
  sessionId: string,
  userText: string,
  fileRefs?: FileRef[],
): Promise<ArchContentBlock[] | undefined> {
  if (!fileRefs || fileRefs.length === 0) {
    return undefined;
  }

  const blocks: ArchContentBlock[] = [];
  if (userText.trim().length > 0) {
    blocks.push({ type: 'text', text: userText });
  }

  for (const ref of fileRefs) {
    try {
      const file = await fileStoreService.getByBlobId(ctx, sessionId, ref.blobId);
      if (file.mediaType.startsWith('image/')) {
        blocks.push({
          type: 'image_ref',
          blobId: ref.blobId,
          name: file.name,
          mediaType: file.mediaType,
          width: file.metadata.width ?? 0,
          height: file.metadata.height ?? 0,
          tokenCost: file.metadata.tokenEstimate,
        });
        continue;
      }

      blocks.push({
        type: 'file_ref',
        blobId: ref.blobId,
        name: file.name,
        mediaType: file.mediaType,
        tokenCost: file.metadata.tokenEstimate,
        summary: summarizeAttachmentText(file),
      });
    } catch (err: unknown) {
      log.warn('failed to resolve fileRef for structured persistence', {
        blobId: ref.blobId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return blocks.length > 0 ? blocks : undefined;
}

export async function augmentUserInputWithFileRefs(
  ctx: ProcessorContext,
  sessionId: string,
  userText: string,
  fileRefs?: FileRef[],
): Promise<string> {
  if (!fileRefs || fileRefs.length === 0) {
    return userText;
  }

  const parts: string[] = [];
  let remainingChars = MAX_TOTAL_FILE_CONTEXT_CHARS;

  for (const ref of fileRefs) {
    if (remainingChars <= 0) {
      break;
    }

    try {
      const file = await fileStoreService.getByBlobId(ctx, sessionId, ref.blobId);
      const attachmentText = resolveAttachmentText(file);
      const truncated = truncateText(
        attachmentText,
        Math.min(MAX_FILE_CONTEXT_CHARS, remainingChars),
      );
      parts.push(truncated);
      remainingChars -= truncated.length;
    } catch (err: unknown) {
      log.warn('failed to resolve fileRef for model input', {
        blobId: ref.blobId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (parts.length === 0) {
    return userText;
  }

  const prefix = userText.trim();
  return prefix.length > 0 ? `${prefix}\n\n${parts.join('\n\n')}` : parts.join('\n\n');
}

export function normalizeStoredMessageContentForLlm(
  content: string | Array<{ type: string; text?: string; name?: string; summary?: string }>,
): string {
  if (typeof content === 'string') {
    return content;
  }

  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text': {
        if (typeof block.text === 'string' && block.text.length > 0) {
          parts.push(block.text);
        }
        break;
      }
      case 'file_ref': {
        const fileLabel = block.name ?? 'attached file';
        const summary =
          typeof block.summary === 'string' && block.summary.trim().length > 0
            ? block.summary.trim()
            : null;
        parts.push(
          summary ? `[Attached file: ${fileLabel}]\n${summary}` : `[Attached file: ${fileLabel}]`,
        );
        break;
      }
      case 'image_ref': {
        parts.push(`[Attached image: ${block.name ?? 'image'}]`);
        break;
      }
      default:
        break;
    }
  }

  return parts.join('\n\n');
}

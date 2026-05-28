/**
 * Content Block Resolver — B03 Multimodality
 *
 * Resolves ArchContentBlock references (file_ref, image_ref) into provider-ready
 * content blocks by fetching file data from the FileStoreService. Also builds
 * a file preamble for the system prompt context window and converts StoredMessages
 * into multimodal LLM messages.
 *
 * Contract: content-blocks.ts (ArchContentBlock / ProviderContentBlock)
 * Contract: file-store-service.ts (FileStoreService, SessionContext)
 * Contract: session.ts (StoredMessage)
 */

import type { ArchContentBlock, ProviderContentBlock } from '../types/content-blocks.js';
import type { StoredMessage } from '../types/session.js';
import type {
  ArchFileStore,
  SessionContext,
  SessionFileRecord,
} from '../session/file-store-service.js';
import { createLogger } from '@agent-platform/shared-observability';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Minimal capabilities needed for content resolution.
 * Decoupled from @abl/compiler's ModelCapabilities since arch-ai does not
 * depend on the compiler package.
 */
export interface ContextCapabilities {
  contextWindow: number;
  supportsVision: boolean;
  /** LLM provider name — determines image format (anthropic, openai, etc.) */
  provider?: string;
}

export interface FilePreambleResult {
  preamble: string;
  evictedFiles: SessionFileRecord[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum characters for inline file content in resolved blocks */
const MAX_FILE_CONTENT_CHARS = 50_000;

/** Fraction of context window that file preamble may occupy */
const PREAMBLE_CONTEXT_FRACTION = 0.5;

/** Approximate chars per token for budget calculations */
const CHARS_PER_TOKEN = 4;

// ─── Logger ─────────────────────────────────────────────────────────────────

const log = createLogger('arch-ai:content-resolver');

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[File truncated at ${maxChars.toLocaleString()} characters]`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith('image/');
}

function resolveFileText(file: SessionFileRecord): string | null {
  if (typeof file.resolvedText === 'string' && file.resolvedText.length > 0) {
    return file.resolvedText;
  }

  if (file.content.length > 0) {
    return file.content.toString('utf-8');
  }

  return null;
}

function buildFileUnavailableMessage(name: string, reason?: string | null): string {
  return reason ? `[File unavailable: ${name} — ${reason}]` : `[File unavailable: ${name}]`;
}

function buildImageUnavailableMessage(name: string, reason?: string | null): string {
  return reason ? `[Image: ${name} — ${reason}]` : `[Image: ${name} — could not be processed]`;
}

function shouldMarkImageFailed(message: string): boolean {
  return !/processing|scan|pending|network|timeout|unavailable/i.test(message);
}

// ─── resolveContentBlocks ───────────────────────────────────────────────────

/**
 * Resolve ArchContentBlock[] into ProviderContentBlock[] ready for LLM consumption.
 *
 * - `text` blocks pass through as-is.
 * - `file_ref` blocks: resolve blobId via fileStore, extract text, wrap in markers.
 * - `image_ref` blocks: Phase 1 returns a text fallback placeholder.
 * - `tool_use` / `tool_result`: pass through unchanged.
 * - Missing files (deleted/evicted) produce a graceful fallback.
 */
export async function resolveContentBlocks(
  blocks: ArchContentBlock[],
  fileStore: ArchFileStore,
  ctx: SessionContext,
  sessionId: string,
  capabilities: ContextCapabilities,
): Promise<ProviderContentBlock[]> {
  const resolved: ProviderContentBlock[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        resolved.push({ type: 'text', text: block.text });
        break;
      }

      case 'file_ref': {
        try {
          const file = await fileStore.getByBlobId(ctx, sessionId, block.blobId);
          const textContent = resolveFileText(file);
          if (!textContent) {
            resolved.push({
              type: 'text',
              text: buildFileUnavailableMessage(block.name, file.unavailableReason),
            });
            break;
          }
          const truncated = truncateText(textContent, MAX_FILE_CONTENT_CHARS);
          resolved.push({
            type: 'text',
            text: `[Attached file available for this request: ${block.name}]\n${truncated}\n[/Attached file]`,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('Failed to resolve file_ref, returning fallback', {
            blobId: block.blobId,
            name: block.name,
            error: msg,
          });
          resolved.push({
            type: 'text',
            text: `[File unavailable: ${block.name}]`,
          });
        }
        break;
      }

      case 'image_ref': {
        // B03 Phase 2: Failed images are silently skipped
        if (block.status === 'failed') {
          log.info('Skipping failed image_ref', { blobId: block.blobId, name: block.name });
          break;
        }

        // Vision-capable model: resolve image data from file store
        if (capabilities.supportsVision) {
          try {
            const file = await fileStore.getByBlobId(ctx, sessionId, block.blobId);

            // Verify the file isn't marked failed in the store
            if (file.status === 'failed') {
              log.info('Skipping image_ref with failed store status', {
                blobId: block.blobId,
                name: block.name,
              });
              break;
            }

            if (file.status === 'processing' || file.status === 'blocked') {
              resolved.push({
                type: 'text',
                text: buildImageUnavailableMessage(block.name, file.unavailableReason),
              });
              break;
            }

            // Provider-specific image format
            if (file.imageSource?.type === 'url' && file.imageSource.url) {
              if (capabilities.provider === 'openai') {
                resolved.push({
                  type: 'image_url',
                  image_url: {
                    url: file.imageSource.url,
                  },
                });
              } else {
                resolved.push({
                  type: 'image',
                  source: {
                    type: 'url',
                    url: file.imageSource.url,
                  },
                });
              }
              break;
            }

            const base64 =
              file.imageSource?.type === 'base64' && file.imageSource.data
                ? file.imageSource.data
                : file.content.toString('base64');

            if (!base64) {
              resolved.push({
                type: 'text',
                text: buildImageUnavailableMessage(block.name, file.unavailableReason),
              });
              break;
            }

            if (capabilities.provider === 'openai') {
              resolved.push({
                type: 'image_url',
                image_url: {
                  url: `data:${block.mediaType};base64,${base64}`,
                },
              });
            } else {
              // Anthropic format (default for anthropic, google, and unknown providers)
              resolved.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: block.mediaType,
                  data: base64,
                },
              });
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn('Failed to resolve image_ref, marking failed and returning fallback', {
              blobId: block.blobId,
              name: block.name,
              error: msg,
            });

            // Best-effort: mark the file as failed so future resolves skip it
            if (shouldMarkImageFailed(msg)) {
              try {
                await fileStore.markFailed(ctx, sessionId, block.blobId);
              } catch (markErr: unknown) {
                log.warn('Failed to mark image as failed', {
                  blobId: block.blobId,
                  error: markErr instanceof Error ? markErr.message : String(markErr),
                });
              }
            }

            resolved.push({
              type: 'text',
              text: buildImageUnavailableMessage(block.name, msg),
            });
          }
        } else {
          // Non-vision model: text fallback with metadata
          resolved.push({
            type: 'text',
            text: `[Image attached: ${block.name}, ${block.width}x${block.height}px, ${block.mediaType} — vision analysis unavailable with current model]`,
          });
        }
        break;
      }

      case 'tool_use': {
        resolved.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;
      }

      case 'tool_result': {
        resolved.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
        });
        break;
      }
    }
  }

  return resolved;
}

// ─── buildFilePreamble ──────────────────────────────────────────────────────

/**
 * Build a file preamble string from active session files for inclusion in
 * the system prompt. Evicts files (images first, then text, oldest-first)
 * if the total token cost exceeds 50% of the context window.
 *
 * Returns the preamble string and the list of evicted files so the caller
 * can emit SSE events to notify the client.
 */
export function buildFilePreamble(
  activeFiles: SessionFileRecord[],
  capabilities: ContextCapabilities,
): FilePreambleResult {
  if (activeFiles.length === 0) {
    return { preamble: '', evictedFiles: [] };
  }

  const maxTokenBudget = Math.floor(capabilities.contextWindow * PREAMBLE_CONTEXT_FRACTION);
  const evictedFiles: SessionFileRecord[] = [];

  // Sort files into image and text categories, each sorted oldest-first for eviction
  const imageFiles = activeFiles
    .filter((f) => isImageMediaType(f.mediaType))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const textFiles = activeFiles
    .filter((f) => !isImageMediaType(f.mediaType))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Compute total token cost
  let totalTokens = activeFiles.reduce((sum, f) => sum + f.metadata.tokenEstimate, 0);

  // Evict images oldest-first until under budget
  while (totalTokens > maxTokenBudget && imageFiles.length > 0) {
    const evicted = imageFiles.shift();
    if (evicted) {
      totalTokens -= evicted.metadata.tokenEstimate;
      evictedFiles.push(evicted);
    }
  }

  // Evict text files oldest-first until under budget
  while (totalTokens > maxTokenBudget && textFiles.length > 0) {
    const evicted = textFiles.shift();
    if (evicted) {
      totalTokens -= evicted.metadata.tokenEstimate;
      evictedFiles.push(evicted);
    }
  }

  // Remaining files (not evicted) — combine both lists
  const remainingFiles = [...imageFiles, ...textFiles];

  if (remainingFiles.length === 0) {
    return { preamble: '', evictedFiles };
  }

  // Build preamble
  const sections: string[] = [];
  sections.push('[Session Files]');

  for (const file of remainingFiles) {
    if (isImageMediaType(file.mediaType)) {
      // Phase 1: image placeholder only
      const width = file.metadata.width ?? 0;
      const height = file.metadata.height ?? 0;
      sections.push(`[Image: ${file.name} (${width}x${height}, ${file.mediaType})]`);
    } else {
      const sizeLabel = formatFileSize(file.size);
      const extension = file.name.split('.').pop()?.toUpperCase() ?? 'FILE';
      const textContent =
        resolveFileText(file) ?? buildFileUnavailableMessage(file.name, file.unavailableReason);
      const truncated = truncateText(textContent, MAX_FILE_CONTENT_CHARS);
      sections.push(`[File: ${file.name} (${extension}, ${sizeLabel})]`);
      sections.push(truncated);
      sections.push('[/File]');
    }
  }

  sections.push('[/Session Files]');

  if (evictedFiles.length > 0) {
    log.info('Evicted files from preamble to fit context budget', {
      evictedCount: evictedFiles.length,
      evictedNames: evictedFiles.map((f) => f.name),
      remainingCount: remainingFiles.length,
      totalTokens,
      maxTokenBudget,
    });
  }

  return {
    preamble: sections.join('\n'),
    evictedFiles,
  };
}

// ─── buildMultimodalMessages ────────────────────────────────────────────────

/**
 * Convert StoredMessage[] from the sliding window into LLM-ready messages.
 *
 * For each message:
 * - If `content` is a string, pass through as-is.
 * - If `content` is ArchContentBlock[], resolve references via resolveContentBlocks.
 *
 * Returns an array suitable for the LLM client's `messages` parameter.
 */
export async function buildMultimodalMessages(
  storedMessages: StoredMessage[],
  fileStore: ArchFileStore,
  ctx: SessionContext,
  sessionId: string,
  capabilities: ContextCapabilities,
): Promise<Array<{ role: string; content: string | ProviderContentBlock[] }>> {
  const result: Array<{ role: string; content: string | ProviderContentBlock[] }> = [];

  for (const msg of storedMessages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const resolved = await resolveContentBlocks(
        msg.content,
        fileStore,
        ctx,
        sessionId,
        capabilities,
      );
      result.push({ role: msg.role, content: resolved });
    } else {
      // Defensive: treat unknown content shape as empty string
      result.push({ role: msg.role, content: '' });
    }
  }

  return result;
}

export type { SessionFileRecord } from '../session/file-store-service.js';

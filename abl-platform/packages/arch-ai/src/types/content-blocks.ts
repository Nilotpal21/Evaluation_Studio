/**
 * Content block types for multimodal messages — B03
 *
 * StoredMessage.content can be either a plain string (backward-compatible)
 * or an array of ArchContentBlock (multimodal). All read sites MUST use
 * normalizeContent() for display text extraction.
 *
 * Provider-specific content blocks (ProviderContentBlock) are used at the
 * executor layer when building LLM messages — they carry the actual base64
 * data or URL in the format the provider expects.
 */

/**
 * Arch-specific content blocks stored in messages.
 * Image/file blocks use blobId references (not inline base64) — resolved
 * at LLM call time by the executor.
 */
export type ArchContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image_ref';
      blobId: string;
      name: string;
      mediaType: string;
      width: number;
      height: number;
      tokenCost: number;
      status?: 'active' | 'failed';
    }
  | {
      type: 'file_ref';
      blobId: string;
      name: string;
      mediaType: string;
      summary?: string;
      tokenCost: number;
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/**
 * Provider-specific content blocks for LLM messages.
 * Built by the executor when resolving ArchContentBlock references.
 */
export type ProviderContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
    }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/**
 * Type guard: is the content an array of ArchContentBlock?
 */
export function isArchContentBlockArray(
  content: string | ArchContentBlock[] | undefined,
): content is ArchContentBlock[] {
  return Array.isArray(content);
}

/**
 * Extract display text from content (string or ArchContentBlock[]).
 * Always returns a string — safe for React rendering and markdown.
 *
 * For ArchContentBlock[], concatenates all 'text' blocks with newlines.
 * For string, returns as-is. For undefined/null, returns empty string.
 */
export function normalizeContent(content: string | ArchContentBlock[] | undefined): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Convert content to ArchContentBlock[] regardless of input type.
 * If content is already an array, return it. If string, wrap in a text block.
 */
export function extractContentBlocks(
  content: string | ArchContentBlock[] | undefined,
): ArchContentBlock[] {
  if (content === undefined || content === null) return [];
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content.length > 0) {
    return [{ type: 'text', text: content }];
  }
  return [];
}

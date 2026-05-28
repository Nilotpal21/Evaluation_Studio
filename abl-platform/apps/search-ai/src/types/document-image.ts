import type { ImageContent } from '@abl/compiler/platform/llm/types';

/**
 * DocumentImageContent - Image content for document extraction and vision analysis
 *
 * Used by: Search-AI vision service, multimodal enrichment service
 * Purpose: Images extracted from documents (PDF, DOCX) via docling
 *
 * Different from platform ImageContent:
 * - Always includes media_type (from docling metadata)
 * - No attachmentId (not part of attachment pipeline)
 * - Discriminant: 'document-image' (vs 'image' for platform type)
 */
export interface DocumentImageContent {
  type: 'document-image';
  source: {
    type: 'base64' | 'url';
    media_type: string; // Always required - from docling extraction metadata
    data?: string;
    url?: string;
  };
}

/**
 * Type guard for DocumentImageContent
 */
export function isDocumentImageContent(block: unknown): block is DocumentImageContent {
  return (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'document-image'
  );
}

/**
 * Convert DocumentImageContent to platform ImageContent for LLM provider calls
 *
 * Note: This conversion is needed because LLM providers expect the platform's
 * ImageContent type in ContentBlock union. When the rebase brings in Prasanna's
 * ImageContent from develop, this will convert our DocumentImageContent to that format.
 *
 * The platform ImageContent (from develop) has structure:
 * - Base64: { type: 'base64'; media_type: string; data: string }
 * - URL: { type: 'url'; url: string; media_type?: string } (optional media_type)
 */
export function toImageContent(doc: DocumentImageContent): ImageContent {
  if (doc.source.type === 'base64') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: doc.source.media_type,
        data: doc.source.data!,
      },
    };
  } else {
    return {
      type: 'image',
      source: {
        type: 'url',
        url: doc.source.url!,
      },
    };
  }
}

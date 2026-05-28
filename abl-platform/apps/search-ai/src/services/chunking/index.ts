/**
 * Chunking Service
 *
 * Splits extracted text into chunks using configurable strategies.
 * Supports fixed-size, semantic, and sliding-window approaches.
 *
 * Uses tiktoken for accurate token counting. Character-based size estimation
 * (4 chars/token) is used for performance-critical chunking boundaries,
 * with accurate token counts calculated after chunks are created.
 */

import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';

// =============================================================================
// TYPES
// =============================================================================

export type ChunkStrategy = 'fixed' | 'semantic' | 'sliding_window';

export interface ChunkOptions {
  strategy: ChunkStrategy;
  /** Target chunk size in tokens (approximate) */
  chunkSize: number;
  /** Overlap between consecutive chunks in tokens */
  chunkOverlap: number;
  /** For semantic strategy: split on paragraph boundaries */
  respectBoundaries?: boolean;
}

export interface TextChunk {
  /** Chunk content */
  content: string;
  /** Chunk index within the document */
  index: number;
  /** Approximate token count */
  tokenCount: number;
  /** Character offset start in original text */
  charStart: number;
  /** Character offset end in original text */
  charEnd: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Approximate characters per token for chunking boundary calculations.
 * Used for performance - calculating window sizes without tokenizing during chunking.
 * Actual token counts are calculated with tiktoken after chunks are created.
 */
const CHARS_PER_TOKEN = 4;

// =============================================================================
// SERVICE
// =============================================================================

export class ChunkingService {
  /**
   * Split text into chunks according to the given options.
   *
   * @param text - The full text to chunk
   * @param options - Chunking strategy and size parameters
   * @returns An array of text chunks with positional metadata
   */
  chunk(text: string, options: ChunkOptions): TextChunk[] {
    if (!text || text.length === 0) {
      return [];
    }

    switch (options.strategy) {
      case 'fixed':
        return this.chunkFixed(text, options);
      case 'semantic':
        return this.chunkSemantic(text, options);
      case 'sliding_window':
        return this.chunkSlidingWindow(text, options);
      default:
        throw new Error(`Unknown chunk strategy: ${options.strategy as string}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Fixed-size chunking
  // ---------------------------------------------------------------------------

  /**
   * Split text into fixed-size character windows.
   * Each window is `chunkSize * CHARS_PER_TOKEN` characters,
   * with `chunkOverlap * CHARS_PER_TOKEN` characters of overlap.
   */
  private chunkFixed(text: string, options: ChunkOptions): TextChunk[] {
    const windowSize = options.chunkSize * CHARS_PER_TOKEN;
    const overlapSize = options.chunkOverlap * CHARS_PER_TOKEN;
    const stepSize = Math.max(windowSize - overlapSize, 1);

    const chunks: TextChunk[] = [];
    let offset = 0;
    let index = 0;

    while (offset < text.length) {
      const charStart = offset;
      const charEnd = Math.min(offset + windowSize, text.length);
      const content = text.slice(charStart, charEnd);

      chunks.push({
        content,
        index,
        tokenCount: this.estimateTokens(content),
        charStart,
        charEnd,
      });

      offset += stepSize;
      index++;

      // Avoid creating a tiny trailing chunk that is entirely within overlap
      if (offset < text.length && text.length - offset < overlapSize) {
        const remaining = text.slice(offset);
        chunks.push({
          content: remaining,
          index,
          tokenCount: this.estimateTokens(remaining),
          charStart: offset,
          charEnd: text.length,
        });
        break;
      }
    }

    return chunks;
  }

  // ---------------------------------------------------------------------------
  // Semantic chunking
  // ---------------------------------------------------------------------------

  /**
   * Split text on paragraph boundaries (`\n\n`).
   * Small paragraphs are merged to approach `chunkSize` tokens.
   * Large paragraphs are split at sentence boundaries, falling back to
   * fixed-size splitting if no sentence boundary exists.
   */
  private chunkSemantic(text: string, options: ChunkOptions): TextChunk[] {
    const targetChars = options.chunkSize * CHARS_PER_TOKEN;
    const respectBoundaries = options.respectBoundaries !== false; // default true

    // Split into paragraphs
    const paragraphs = respectBoundaries ? text.split(/\n\n+/) : text.split(/\n+/);

    const chunks: TextChunk[] = [];
    let currentContent = '';
    let currentCharStart = 0;
    let charCursor = 0;
    let index = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      // Track the position in the original text
      const paragraphStart = text.indexOf(paragraph, charCursor);
      const paragraphEnd = paragraphStart + paragraph.length;

      if (currentContent.length === 0) {
        currentCharStart = paragraphStart;
      }

      // Check if adding this paragraph would exceed the target
      const candidateContent =
        currentContent.length > 0 ? currentContent + '\n\n' + paragraph : paragraph;

      if (candidateContent.length <= targetChars) {
        // Merge into current chunk
        currentContent = candidateContent;
      } else {
        // Flush current chunk if it has content
        if (currentContent.length > 0) {
          const charEnd = currentCharStart + currentContent.length;
          // Find the actual end position in original text
          const actualEnd = this.findOriginalEnd(text, currentCharStart, currentContent);
          chunks.push({
            content: currentContent,
            index,
            tokenCount: this.estimateTokens(currentContent),
            charStart: currentCharStart,
            charEnd: actualEnd,
          });
          index++;
        }

        // Handle the current paragraph
        if (paragraph.length <= targetChars) {
          currentContent = paragraph;
          currentCharStart = paragraphStart;
        } else {
          // Large paragraph — split it into sentences or fixed chunks
          const subChunks = this.splitLargeParagraph(paragraph, targetChars, paragraphStart);
          for (const sub of subChunks) {
            chunks.push({
              ...sub,
              index,
            });
            index++;
          }
          currentContent = '';
          currentCharStart = paragraphEnd;
        }
      }

      charCursor = paragraphEnd;
    }

    // Flush remaining content
    if (currentContent.length > 0) {
      const actualEnd = this.findOriginalEnd(text, currentCharStart, currentContent);
      chunks.push({
        content: currentContent,
        index,
        tokenCount: this.estimateTokens(currentContent),
        charStart: currentCharStart,
        charEnd: actualEnd,
      });
    }

    return chunks;
  }

  /**
   * Split a large paragraph into sentence-boundary chunks.
   * Falls back to fixed-size splitting if no sentence boundaries are found.
   */
  private splitLargeParagraph(
    paragraph: string,
    targetChars: number,
    baseOffset: number,
  ): Omit<TextChunk, 'index'>[] {
    // Try to split on sentence boundaries
    const sentences = paragraph.match(/[^.!?]+[.!?]+\s*/g);

    if (sentences && sentences.length > 1) {
      const results: Omit<TextChunk, 'index'>[] = [];
      let current = '';
      let currentStart = baseOffset;
      let cursor = 0;

      for (const sentence of sentences) {
        if (current.length + sentence.length > targetChars && current.length > 0) {
          results.push({
            content: current.trimEnd(),
            tokenCount: this.estimateTokens(current),
            charStart: currentStart,
            charEnd: currentStart + current.trimEnd().length,
          });
          currentStart = baseOffset + cursor;
          current = sentence;
        } else {
          current += sentence;
        }
        cursor += sentence.length;
      }

      if (current.length > 0) {
        results.push({
          content: current.trimEnd(),
          tokenCount: this.estimateTokens(current),
          charStart: currentStart,
          charEnd: currentStart + current.trimEnd().length,
        });
      }

      return results;
    }

    // No sentence boundaries — fall back to fixed-size
    const results: Omit<TextChunk, 'index'>[] = [];
    let offset = 0;
    while (offset < paragraph.length) {
      const end = Math.min(offset + targetChars, paragraph.length);
      const content = paragraph.slice(offset, end);
      results.push({
        content,
        tokenCount: this.estimateTokens(content),
        charStart: baseOffset + offset,
        charEnd: baseOffset + end,
      });
      offset = end;
    }

    return results;
  }

  /**
   * Find the actual end position of content within the original text,
   * accounting for paragraph separators that may have been replaced.
   */
  private findOriginalEnd(text: string, charStart: number, content: string): number {
    // Best effort: search for the end within a reasonable range
    const searchEnd = Math.min(charStart + content.length + 20, text.length);
    const segment = text.slice(charStart, searchEnd);
    // The content may differ slightly from the original due to separator normalization
    // Use the content length as a baseline
    return Math.min(charStart + content.length, text.length);
  }

  // ---------------------------------------------------------------------------
  // Sliding-window chunking
  // ---------------------------------------------------------------------------

  /**
   * Fixed-size windows with overlap. Functionally identical to `fixed`,
   * but semantically distinct: sliding window emphasizes the overlap
   * for context continuity, whereas fixed emphasizes coverage.
   */
  private chunkSlidingWindow(text: string, options: ChunkOptions): TextChunk[] {
    return this.chunkFixed(text, options);
  }

  // ---------------------------------------------------------------------------
  // Token estimation
  // ---------------------------------------------------------------------------

  /**
   * Count the number of tokens in a text string using tiktoken.
   *
   * @param text - The text to count tokens for
   * @returns Accurate token count
   */
  private estimateTokens(text: string): number {
    return countTokens(text);
  }
}

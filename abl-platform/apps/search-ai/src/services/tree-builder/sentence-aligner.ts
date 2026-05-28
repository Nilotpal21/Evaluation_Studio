/**
 * Sentence Aligner
 *
 * Splits text into sentences using compromise (JS-native NLP library).
 * Ensures chunks never split sentences across boundaries.
 */

import nlp from 'compromise';
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';

export interface SentenceSpan {
  text: string;
  startOffset: number;
  endOffset: number;
  tokenCount: number;
}

export interface SentenceAlignmentConfig {
  /** Target chunk size in tokens (soft limit) */
  targetChunkSize: number;
  /** Maximum chunk size in tokens (hard limit) */
  maxChunkSize: number;
  /** Minimum chunk size in tokens */
  minChunkSize: number;
}

export class SentenceAligner {
  private config: SentenceAlignmentConfig;

  constructor(config: Partial<SentenceAlignmentConfig> = {}) {
    this.config = {
      targetChunkSize: config.targetChunkSize ?? 512,
      maxChunkSize: config.maxChunkSize ?? 1024,
      minChunkSize: config.minChunkSize ?? 128,
    };
  }

  /**
   * Split text into sentence spans
   */
  splitIntoSentences(text: string): SentenceSpan[] {
    const doc = nlp(text);
    const sentences = doc.sentences().json();

    const spans: SentenceSpan[] = [];
    let currentOffset = 0;

    for (const sentence of sentences) {
      const sentenceText = sentence.text || '';
      const startOffset = text.indexOf(sentenceText, currentOffset);

      if (startOffset === -1) {
        // Fallback: use current offset if exact match not found
        spans.push({
          text: sentenceText,
          startOffset: currentOffset,
          endOffset: currentOffset + sentenceText.length,
          tokenCount: this.estimateTokenCount(sentenceText),
        });
        currentOffset += sentenceText.length;
      } else {
        spans.push({
          text: sentenceText,
          startOffset,
          endOffset: startOffset + sentenceText.length,
          tokenCount: this.estimateTokenCount(sentenceText),
        });
        currentOffset = startOffset + sentenceText.length;
      }
    }

    return spans;
  }

  /**
   * Align sentences into chunks respecting sentence boundaries
   */
  alignIntoChunks(sentences: SentenceSpan[]): SentenceSpan[][] {
    const chunks: SentenceSpan[][] = [];
    let currentChunk: SentenceSpan[] = [];
    let currentTokenCount = 0;

    for (const sentence of sentences) {
      const sentenceTokens = sentence.tokenCount;

      // If adding this sentence would exceed max size, finalize current chunk
      if (
        currentTokenCount + sentenceTokens > this.config.maxChunkSize &&
        currentChunk.length > 0
      ) {
        chunks.push(currentChunk);
        currentChunk = [sentence];
        currentTokenCount = sentenceTokens;
      }
      // If this single sentence exceeds max size, make it its own chunk
      else if (sentenceTokens > this.config.maxChunkSize) {
        if (currentChunk.length > 0) {
          chunks.push(currentChunk);
        }
        chunks.push([sentence]);
        currentChunk = [];
        currentTokenCount = 0;
      }
      // Otherwise, add to current chunk
      else {
        currentChunk.push(sentence);
        currentTokenCount += sentenceTokens;

        // If we've reached target size, finalize chunk
        if (currentTokenCount >= this.config.targetChunkSize) {
          chunks.push(currentChunk);
          currentChunk = [];
          currentTokenCount = 0;
        }
      }
    }

    // Add remaining sentences as final chunk if above min size
    if (currentChunk.length > 0) {
      if (currentTokenCount >= this.config.minChunkSize) {
        chunks.push(currentChunk);
      } else if (chunks.length > 0) {
        // Merge with previous chunk if too small
        chunks[chunks.length - 1].push(...currentChunk);
      } else {
        // Keep even if below min size if it's the only chunk
        chunks.push(currentChunk);
      }
    }

    return chunks;
  }

  /**
   * Count tokens using tiktoken for accurate sentence-level chunking
   */
  private estimateTokenCount(text: string): number {
    return countTokens(text);
  }

  /**
   * Merge sentence spans into single text
   */
  static mergeSpans(spans: SentenceSpan[]): string {
    return spans.map((s) => s.text).join(' ');
  }

  /**
   * Get total token count for sentence spans
   */
  static getTotalTokenCount(spans: SentenceSpan[]): number {
    return spans.reduce((sum, s) => sum + s.tokenCount, 0);
  }
}

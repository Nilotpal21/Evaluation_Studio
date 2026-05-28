/**
 * JSON Object Chunking Strategy
 *
 * Design:
 * 1. One JSON object = One SearchChunk (if under token limit)
 * 2. If embeddable fields overflow token limits: Apply document text-splitting approach
 * 3. Follow existing sentence-aligned chunking pipeline
 *
 * Example:
 * - Small JSON object (500 tokens): 1 chunk
 * - Large JSON object with 10k token description field: 1 metadata chunk + N text chunks
 */

import { SentenceAligner, type SentenceAlignmentConfig } from '../tree-builder/sentence-aligner.js';
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';

export interface JSONChunkingConfig {
  /** Maximum tokens per chunk (default: 8000 - conservative for most embeddings) */
  maxTokensPerChunk: number;
  /** Sentence alignment config for overflow text splitting */
  sentenceAlignment: SentenceAlignmentConfig;
}

export interface JSONObjectMetadata {
  objectId: string;
  objectType?: string;
  schema?: Record<string, any>;
  [key: string]: any;
}

export interface JSONChunkingRequest {
  jsonObject: Record<string, any>;
  embeddableFields: string[]; // Fields that should be embedded
  metadata: JSONObjectMetadata;
  config?: Partial<JSONChunkingConfig>;
}

export interface JSONChunk {
  type: 'json_object' | 'json_field_overflow';
  objectId: string;
  chunkIndex: number;
  content: string; // JSON string or text content
  fieldPath?: string; // For overflow chunks: which field this came from
  tokenCount: number;
  metadata: Record<string, any>;
}

export interface JSONChunkingResult {
  chunks: JSONChunk[];
  totalTokens: number;
  overflowFields: string[]; // Fields that needed text splitting
  statistics: {
    totalChunks: number;
    objectChunks: number; // Full JSON object chunks
    overflowChunks: number; // Text-split field chunks
  };
}

const DEFAULT_CONFIG: JSONChunkingConfig = {
  maxTokensPerChunk: 8000, // Conservative limit for most embedding models
  sentenceAlignment: {
    targetChunkSize: 512,
    maxChunkSize: 1024,
    minChunkSize: 128,
  },
};

export class JSONChunkingStrategy {
  /**
   * Chunk a JSON object based on token limits
   */
  chunk(request: JSONChunkingRequest): JSONChunkingResult {
    const config = { ...DEFAULT_CONFIG, ...request.config };
    const { jsonObject, embeddableFields, metadata } = request;

    // Step 1: Calculate total token count of embeddable content
    const embeddableContent = this.extractEmbeddableContent(jsonObject, embeddableFields);
    const totalTokens = this.estimateTokenCount(embeddableContent);

    // Step 2: If under limit, create single chunk
    if (totalTokens <= config.maxTokensPerChunk) {
      return this.createSingleChunk(jsonObject, metadata, totalTokens);
    }

    // Step 3: Identify overflow fields
    const overflowFields = this.identifyOverflowFields(jsonObject, embeddableFields, config);

    // Step 4: If no individual field is too large, still return single chunk
    // (multiple small fields adding up to large total is OK - embed them together)
    if (overflowFields.length === 0) {
      return this.createSingleChunk(jsonObject, metadata, totalTokens);
    }

    // Step 5: Split overflow fields into sub-chunks using sentence alignment
    return this.createChunksWithOverflow(
      jsonObject,
      embeddableFields,
      overflowFields,
      metadata,
      config,
    );
  }

  /**
   * Create single chunk for entire JSON object (no overflow)
   */
  private createSingleChunk(
    jsonObject: Record<string, any>,
    metadata: JSONObjectMetadata,
    tokenCount: number,
  ): JSONChunkingResult {
    const chunk: JSONChunk = {
      type: 'json_object',
      objectId: metadata.objectId,
      chunkIndex: 0,
      content: JSON.stringify(jsonObject),
      tokenCount,
      metadata: {
        ...metadata,
        chunkingStrategy: 'single',
      },
    };

    return {
      chunks: [chunk],
      totalTokens: tokenCount,
      overflowFields: [],
      statistics: {
        totalChunks: 1,
        objectChunks: 1,
        overflowChunks: 0,
      },
    };
  }

  /**
   * Create chunks with overflow field splitting
   */
  private createChunksWithOverflow(
    jsonObject: Record<string, any>,
    embeddableFields: string[],
    overflowFields: string[],
    metadata: JSONObjectMetadata,
    config: JSONChunkingConfig,
  ): JSONChunkingResult {
    const chunks: JSONChunk[] = [];
    let chunkIndex = 0;

    // Create metadata chunk (object without overflow fields)
    const metadataObject = { ...jsonObject };
    for (const field of overflowFields) {
      if (field in metadataObject) {
        metadataObject[field] = `[Large field - see separate chunks]`;
      }
    }

    const metadataChunk: JSONChunk = {
      type: 'json_object',
      objectId: metadata.objectId,
      chunkIndex: chunkIndex++,
      content: JSON.stringify(metadataObject),
      tokenCount: this.estimateTokenCount(JSON.stringify(metadataObject)),
      metadata: {
        ...metadata,
        chunkingStrategy: 'overflow',
        overflowFields,
      },
    };
    chunks.push(metadataChunk);

    // Split each overflow field using sentence alignment
    const aligner = new SentenceAligner(config.sentenceAlignment);
    let totalOverflowChunks = 0;

    for (const fieldPath of overflowFields) {
      const fieldValue = jsonObject[fieldPath];
      if (!fieldValue || typeof fieldValue !== 'string') continue;

      // Split field text into sentence-aligned chunks
      const sentences = aligner.splitIntoSentences(fieldValue);
      const sentenceGroups = aligner.alignIntoChunks(sentences);

      for (const sentenceGroup of sentenceGroups) {
        const text = SentenceAligner.mergeSpans(sentenceGroup);
        const tokenCount = SentenceAligner.getTotalTokenCount(sentenceGroup);

        const fieldChunk: JSONChunk = {
          type: 'json_field_overflow',
          objectId: metadata.objectId,
          chunkIndex: chunkIndex++,
          content: text,
          fieldPath,
          tokenCount,
          metadata: {
            ...metadata,
            fieldPath,
            parentChunkIndex: 0, // References metadata chunk
          },
        };
        chunks.push(fieldChunk);
        totalOverflowChunks++;
      }
    }

    const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0);

    return {
      chunks,
      totalTokens,
      overflowFields,
      statistics: {
        totalChunks: chunks.length,
        objectChunks: 1,
        overflowChunks: totalOverflowChunks,
      },
    };
  }

  /**
   * Extract embeddable content from JSON object
   */
  private extractEmbeddableContent(
    jsonObject: Record<string, any>,
    embeddableFields: string[],
  ): string {
    const parts: string[] = [];

    for (const field of embeddableFields) {
      const value = jsonObject[field];
      if (value !== null && value !== undefined && value !== '') {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        parts.push(text);
      }
    }

    return parts.join(' ');
  }

  /**
   * Identify fields that individually exceed token limits
   */
  private identifyOverflowFields(
    jsonObject: Record<string, any>,
    embeddableFields: string[],
    config: JSONChunkingConfig,
  ): string[] {
    const overflowFields: string[] = [];

    for (const field of embeddableFields) {
      const value = jsonObject[field];
      if (!value || typeof value !== 'string') continue;

      const tokenCount = this.estimateTokenCount(value);

      // Field is overflow if it alone exceeds max chunk size
      if (tokenCount > config.maxTokensPerChunk) {
        overflowFields.push(field);
      }
    }

    return overflowFields;
  }

  /**
   * Count tokens using tiktoken for accurate JSON chunking
   */
  private estimateTokenCount(text: string): number {
    return countTokens(text);
  }
}

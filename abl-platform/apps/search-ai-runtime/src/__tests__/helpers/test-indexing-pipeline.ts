/**
 * Test Indexing Pipeline
 *
 * Simplified in-process indexing pipeline for E2E tests.
 * Creates SearchDocument and SearchChunk records with embedding support.
 *
 * This version does not depend on the removed ChunkingService.
 * Instead, it implements basic fixed-size chunking inline for testing purposes.
 */

import type { EmbeddingProvider } from '@agent-platform/search-ai-internal/embedding';
import type {
  VectorStoreProvider,
  VectorRecord,
} from '@agent-platform/search-ai-internal/vector-store';

// =============================================================================
// TYPES
// =============================================================================

export interface IngestDocumentParams {
  indexId: string;
  sourceId: string;
  tenantId: string;
  projectId: string;
  title: string;
  rawText: string;
  sourceMetadata: Record<string, unknown>;
}

export interface IngestResult {
  documentId: string;
  chunkIds: string[];
  chunkCount: number;
}

export interface ChunkOptions {
  strategy?: 'fixed' | 'sentence' | 'paragraph';
  chunkSize?: number;
  chunkOverlap?: number;
}

// =============================================================================
// SIMPLE CHUNKING LOGIC
// =============================================================================

interface TextChunk {
  content: string;
  index: number;
  tokenCount: number;
}

/**
 * Basic fixed-size chunking for testing purposes.
 * Splits text into chunks of approximately chunkSize characters with overlap.
 */
function chunkText(
  text: string,
  options: { chunkSize: number; chunkOverlap: number },
): TextChunk[] {
  const { chunkSize, chunkOverlap } = options;
  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const content = text.slice(start, end);

    // Simple token count estimation (words * 1.3)
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const tokenCount = Math.ceil(wordCount * 1.3);

    chunks.push({
      content,
      index,
      tokenCount,
    });

    index++;

    // If we've reached the end of the text, stop
    if (end >= text.length) {
      break;
    }

    // Move start forward, accounting for overlap
    start = end - chunkOverlap;
  }

  return chunks;
}

// =============================================================================
// PIPELINE
// =============================================================================

export class TestIndexingPipeline {
  constructor(
    private embeddingProvider: EmbeddingProvider,
    private vectorStore: VectorStoreProvider,
    private chunkOptions?: Partial<ChunkOptions>,
  ) {}

  /**
   * Run a document through all pipeline stages sequentially.
   *
   * Models (SearchDocument, SearchChunk) are dynamically imported to work
   * correctly in vitest forks mode where mongoose registers models per-process.
   */
  async ingestDocument(params: IngestDocumentParams): Promise<IngestResult> {
    const { SearchDocument } = await import('@agent-platform/database/models/search-document');
    const { SearchChunk } = await import('@agent-platform/database/models/search-chunk');

    const { indexId, sourceId, tenantId, title, rawText, sourceMetadata } = params;

    // ── Stage 1: Ingestion ──────────────────────────────────────────────────
    const contentHash = this.simpleHash(rawText);
    const doc = await SearchDocument.create({
      tenantId,
      indexId,
      sourceId,
      contentHash,
      originalReference: title,
      contentType: 'text/plain',
      contentSizeBytes: Buffer.byteLength(rawText, 'utf-8'),
      extractedText: rawText,
      sourceMetadata,
      status: 'pending',
    });
    const documentId = doc._id as string;

    // ── Stage 2: Extraction ─────────────────────────────────────────────────
    // In production, extraction converts PDF/HTML/etc to plain text.
    // Here rawText is already plain text, so we just update status.
    await SearchDocument.findByIdAndUpdate(documentId, {
      status: 'extracted',
    });

    // ── Stage 3: Chunking ───────────────────────────────────────────────────
    const chunkSize = this.chunkOptions?.chunkSize ?? 256;
    const chunkOverlap = this.chunkOptions?.chunkOverlap ?? 32;

    const textChunks = chunkText(rawText, { chunkSize, chunkOverlap });

    // Create SearchChunk records one-by-one
    const chunkIds: string[] = [];
    for (const tc of textChunks) {
      const chunk = await SearchChunk.create({
        tenantId,
        indexId,
        documentId,
        content: tc.content,
        tokenCount: tc.tokenCount,
        chunkIndex: tc.index,
        metadata: sourceMetadata,
        // Canonical mapping is a pass-through
        canonicalMetadata: { ...sourceMetadata },
        status: 'pending',
      });
      chunkIds.push(chunk._id as string);
    }

    await SearchDocument.findByIdAndUpdate(documentId, {
      chunkCount: chunkIds.length,
      status: 'enriched',
    });

    // ── Stage 4: Enrichment ─────────────────────────────────────────────────
    // Add charCount, wordCount, language to canonicalMetadata
    for (const chunkId of chunkIds) {
      const chunk = await SearchChunk.findById(chunkId);
      if (!chunk) continue;

      const charCount = chunk.content.length;
      const wordCount = chunk.content.split(/\s+/).filter(Boolean).length;

      const canonicalMetadata = {
        ...(chunk.canonicalMetadata ?? {}),
        charCount,
        wordCount,
        language: 'en',
        enrichedAt: new Date().toISOString(),
      };

      await SearchChunk.findByIdAndUpdate(chunkId, {
        canonicalMetadata,
        status: 'pending', // ready for embedding
      });
    }

    // Update document with summary + language
    const summary = this.generateSummary(rawText);
    await SearchDocument.findByIdAndUpdate(documentId, {
      summary,
      language: 'en',
      status: 'enriched',
    });

    // ── Stage 5: Embedding ──────────────────────────────────────────────────
    // Reload chunks to get enriched canonicalMetadata
    const chunks = await SearchChunk.find({ documentId, indexId }).sort({ chunkIndex: 1 });
    const texts = chunks.map((c) => c.content);

    const embeddingResult = await this.embeddingProvider.embedBatch(texts);

    const vectorRecords: VectorRecord[] = chunks.map((chunk, i) => ({
      id: chunk._id as string,
      vector: embeddingResult.embeddings[i],
      metadata: {
        // Match production shape from embedding-worker: nested sys/doc/canonical
        sys: {
          tenantId,
          appId: indexId,
          documentId,
          chunkId: chunk._id as string,
          chunkIndex: chunk.chunkIndex,
        },
        canonical: chunk.canonicalMetadata ?? {},
        // Keep flat fields for backward compat with existing test assertions
        indexId,
        documentId,
        chunkIndex: chunk.chunkIndex,
        tenantId,
        ...(chunk.canonicalMetadata ?? {}),
      },
      content: chunk.content,
    }));

    await this.vectorStore.upsert(indexId, vectorRecords);

    // Update chunks with vectorId + indexed status
    for (const chunk of chunks) {
      await SearchChunk.findByIdAndUpdate(chunk._id, {
        vectorId: chunk._id,
        status: 'indexed',
      });
    }

    // Mark document as indexed
    await SearchDocument.findByIdAndUpdate(documentId, {
      status: 'indexed',
    });

    return {
      documentId,
      chunkIds,
      chunkCount: chunkIds.length,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private simpleHash(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      hash = ((hash << 5) - hash + ch) | 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  private generateSummary(content: string, maxLength = 500): string {
    if (content.length <= maxLength) return content;
    const truncated = content.slice(0, maxLength);
    const lastPeriod = truncated.lastIndexOf('.');
    if (lastPeriod > maxLength * 0.5) {
      return truncated.slice(0, lastPeriod + 1);
    }
    return truncated + '...';
  }
}

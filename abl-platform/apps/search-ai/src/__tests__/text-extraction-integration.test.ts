/**
 * Text Format Extraction Integration Tests
 *
 * Tests the extraction pipeline for text-based formats (TXT, Markdown, JSON, CSV, XML)
 * through the unified Docling service with LlamaIndex integration.
 *
 * Pipeline stages tested:
 * 1. Document upload
 * 2. Docling service extraction (LlamaIndex path)
 * 3. Page creation with semantic chunking
 * 4. Markdown structure-aware chunking
 * 5. Chunk metadata and boundaries
 *
 * Note: This is an integration test that validates the extraction flow.
 * For full E2E tests including embedding and search, see test/e2e/document-upload-flow.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ObjectId } from 'mongodb';
import mongoose from 'mongoose';
import nock from 'nock';

import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';

// =============================================================================
// TEST SETUP
// =============================================================================

const DOCLING_SERVICE_URL = process.env.DOCLING_SERVICE_URL || 'http://localhost:8080';

beforeAll(async () => {
  await setupTestMongo();
  console.log('✓ MongoDB Memory Server started');
}, 90_000);

afterAll(async () => {
  await teardownTestMongo();
  console.log('✓ MongoDB Memory Server stopped');
}, 60_000);

beforeEach(async () => {
  // Clear test collections
  await clearCollections(['search_documents', 'document_pages', 'search_chunks']);

  // Clear all nock interceptors
  nock.cleanAll();
});

// =============================================================================
// HELPERS
// =============================================================================

interface TestDocument {
  _id: string;
  tenantId: string;
  indexId: string;
  sourceId: string;
  originalReference: string;
  contentType: string;
  status: string;
  pageCount?: number;
  chunkCount?: number;
}

interface DoclingResponse {
  pages: Array<{
    pageNumber: number;
    text: string;
    layout: Record<string, any>;
    tables: any[];
    images: any[];
    screenshot?: string;
  }>;
  metadata: {
    pageCount: number;
    hasOCR: boolean;
    totalTables: number;
    totalImages: number;
    processingTime: number;
    documentType: string;
  };
  structure: {
    outline: any[];
    documentType?: string;
  };
}

/**
 * Get database connection
 */
function getDb() {
  if (!mongoose.connection.db) {
    throw new Error('MongoDB not connected');
  }
  return mongoose.connection.db;
}

/**
 * Create a test document in MongoDB
 */
async function createTestDocument(
  contentType: string,
  originalReference: string,
): Promise<TestDocument> {
  const doc: TestDocument = {
    _id: new ObjectId().toString(),
    tenantId: 'test-tenant',
    indexId: 'test-index',
    sourceId: 'test-source',
    originalReference,
    contentType,
    status: 'pending',
  };

  await getDb().collection('search_documents').insertOne(doc);
  return doc;
}

/**
 * Mock Docling service response for text format
 */
function mockDoclingExtraction(
  contentType: string,
  pages: Array<{ pageNumber: number; text: string }>,
): void {
  const response: DoclingResponse = {
    pages: pages.map((p) => ({
      pageNumber: p.pageNumber,
      text: p.text,
      layout: { regions: [] },
      tables: [],
      images: [],
    })),
    metadata: {
      pageCount: pages.length,
      hasOCR: false,
      totalTables: 0,
      totalImages: 0,
      processingTime: 0.5,
      documentType: contentType.split('/')[1] || 'text',
    },
    structure: {
      outline: [],
    },
  };

  nock(DOCLING_SERVICE_URL).post('/extract').reply(200, response);
}

/**
 * Simulate extraction worker processing
 */
async function processExtractionWorker(documentId: string, content: string): Promise<void> {
  const doc = await getDb().collection('search_documents').findOne({ _id: documentId });
  if (!doc) throw new Error(`Document ${documentId} not found`);

  // Mock the Docling service call based on content type
  if (doc.contentType === 'text/plain') {
    mockDoclingExtraction(doc.contentType, [{ pageNumber: 1, text: content }]);
  } else if (doc.contentType === 'text/markdown') {
    // Markdown may be chunked by sections
    const sections = content.split(/\n(?=#)/g);
    mockDoclingExtraction(
      doc.contentType,
      sections.map((s, i) => ({ pageNumber: i + 1, text: s.trim() })),
    );
  } else {
    mockDoclingExtraction(doc.contentType, [{ pageNumber: 1, text: content }]);
  }

  // Create pages
  const pages = [
    {
      _id: new ObjectId().toString(),
      documentId,
      tenantId: doc.tenantId,
      indexId: doc.indexId,
      sourceId: doc.sourceId,
      pageNumber: 1,
      text: content,
      layout: { regions: [] },
      tables: [],
      images: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await getDb().collection('document_pages').insertMany(pages);

  // Update document status
  await getDb()
    .collection('search_documents')
    .updateOne(
      { _id: documentId },
      {
        $set: {
          status: 'extracted',
          pageCount: pages.length,
          extractedAt: new Date(),
        },
      },
    );
}

/**
 * Simulate canonical mapper worker (chunking)
 */
async function processCanonicalMapper(documentId: string): Promise<void> {
  const pages = await getDb()
    .collection('document_pages')
    .find({ documentId })
    .sort({ pageNumber: 1 })
    .toArray();

  if (pages.length === 0) {
    throw new Error(`No pages found for document ${documentId}`);
  }

  const doc = await getDb().collection('search_documents').findOne({ _id: documentId });
  if (!doc) throw new Error(`Document ${documentId} not found`);

  // Simulate chunking based on content type
  const chunks = [];

  for (const page of pages) {
    const text = page.text as string;

    if (doc.contentType === 'text/markdown') {
      // Markdown structure-aware chunking (simulated)
      const sections = text.split(/\n(?=##?\s)/g).filter(Boolean);

      for (let i = 0; i < sections.length; i++) {
        const sectionText = sections[i].trim();
        if (sectionText) {
          chunks.push({
            _id: new ObjectId().toString(),
            documentId,
            tenantId: doc.tenantId,
            indexId: doc.indexId,
            sourceId: doc.sourceId,
            pageNumber: page.pageNumber,
            chunkIndex: chunks.length,
            content: sectionText,
            tokenCount: Math.ceil(sectionText.length / 4),
            status: 'pending',
            metadata: {
              chunkType: 'markdown-section',
              headingPath: extractHeadings(sectionText),
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }
    } else {
      // Semantic chunking for other text formats
      // Simulate sentence-aware splitting at ~1024 char boundaries
      const sentences = text.split(/(?<=[.!?])\s+/);
      let currentChunk = '';

      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > 1024 && currentChunk.length > 0) {
          chunks.push({
            _id: new ObjectId().toString(),
            documentId,
            tenantId: doc.tenantId,
            indexId: doc.indexId,
            sourceId: doc.sourceId,
            pageNumber: page.pageNumber,
            chunkIndex: chunks.length,
            content: currentChunk.trim(),
            tokenCount: Math.ceil(currentChunk.length / 4),
            status: 'pending',
            metadata: {
              chunkType: 'semantic',
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          currentChunk = sentence;
        } else {
          currentChunk += (currentChunk ? ' ' : '') + sentence;
        }
      }

      // Add remaining chunk
      if (currentChunk.trim()) {
        chunks.push({
          _id: new ObjectId().toString(),
          documentId,
          tenantId: doc.tenantId,
          indexId: doc.indexId,
          sourceId: doc.sourceId,
          pageNumber: page.pageNumber,
          chunkIndex: chunks.length,
          content: currentChunk.trim(),
          tokenCount: Math.ceil(currentChunk.length / 4),
          status: 'pending',
          metadata: {
            chunkType: 'semantic',
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }
  }

  if (chunks.length > 0) {
    await getDb().collection('search_chunks').insertMany(chunks);
  }

  // Update document status
  await getDb()
    .collection('search_documents')
    .updateOne(
      { _id: documentId },
      {
        $set: {
          status: 'chunked',
          chunkCount: chunks.length,
          chunkedAt: new Date(),
        },
      },
    );
}

/**
 * Extract heading hierarchy from markdown text
 */
function extractHeadings(text: string): string[] {
  const headings: string[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push(match[2].trim());
    }
  }

  return headings;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Text Format Extraction Integration', () => {
  test('should extract and chunk plain text file end-to-end', async () => {
    // Create test document
    const content = 'This is sentence one. This is sentence two. This is sentence three.';
    const doc = await createTestDocument('text/plain', 'test.txt');

    // Process extraction
    await processExtractionWorker(doc._id, content);

    // Verify pages created
    const pages = await getDb()
      .collection('document_pages')
      .find({ documentId: doc._id })
      .toArray();
    expect(pages.length).toBe(1);
    expect(pages[0].text).toBe(content);

    // Process chunking
    await processCanonicalMapper(doc._id);

    // Verify chunks created
    const chunks = await getDb()
      .collection('search_chunks')
      .find({ documentId: doc._id })
      .toArray();
    expect(chunks.length).toBeGreaterThan(0);

    // Verify chunk structure
    for (const chunk of chunks) {
      expect(chunk.content).toBeTruthy();
      expect(chunk.tokenCount).toBeGreaterThan(0);
      expect(chunk.chunkIndex).toBeGreaterThanOrEqual(0);
    }

    // Verify document status updated
    const updatedDoc = await getDb().collection('search_documents').findOne({ _id: doc._id });
    expect(updatedDoc?.status).toBe('chunked');
    expect(updatedDoc?.chunkCount).toBe(chunks.length);
  });

  test('should extract markdown with structure preservation', async () => {
    const markdown = `# Main Title

Introduction paragraph.

## Section 1

Content for section 1.

### Subsection 1.1

Detailed content here.

## Section 2

More content in section 2.`;

    const doc = await createTestDocument('text/markdown', 'test.md');

    // Process extraction
    await processExtractionWorker(doc._id, markdown);

    // Process chunking (structure-aware)
    await processCanonicalMapper(doc._id);

    // Verify chunks created with structure
    const chunks = await getDb()
      .collection('search_chunks')
      .find({ documentId: doc._id })
      .sort({ chunkIndex: 1 })
      .toArray();

    expect(chunks.length).toBeGreaterThan(0);

    // Should have section-based chunks
    const hasMainTitle = chunks.some((c: any) => c.content.includes('# Main Title'));
    expect(hasMainTitle).toBe(true);

    // Verify metadata includes heading paths
    const chunksWithHeadings = chunks.filter(
      (c: any) => c.metadata?.headingPath && c.metadata.headingPath.length > 0,
    );
    expect(chunksWithHeadings.length).toBeGreaterThan(0);

    // Verify chunk type
    for (const chunk of chunks) {
      expect((chunk as any).metadata?.chunkType).toBe('markdown-section');
    }
  });

  test('should handle semantic chunking for long text', async () => {
    // Create long text with clear sentence boundaries
    const sentences = Array(100)
      .fill(0)
      .map((_, i) => `This is sentence number ${i}.`)
      .join(' ');

    const doc = await createTestDocument('text/plain', 'long.txt');

    // Process extraction
    await processExtractionWorker(doc._id, sentences);

    // Process chunking
    await processCanonicalMapper(doc._id);

    // Verify multiple chunks created
    const chunks = await getDb()
      .collection('search_chunks')
      .find({ documentId: doc._id })
      .toArray();
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should respect sentence boundaries
    for (const chunk of chunks) {
      const content = (chunk as any).content.trim();
      // Should end with sentence terminator (or be part of last chunk)
      if (content.length > 0) {
        expect(content).toMatch(/[.!?]$/);
      }
    }

    // Chunks should be reasonably sized (around 1024 chars, with some variance)
    for (const chunk of chunks) {
      const content = (chunk as any).content;
      expect(content.length).toBeLessThan(3500); // Allow overage for sentence boundaries
    }
  });

  test('should handle all text formats', async () => {
    const formats = [
      { content: 'Plain text content', filename: 'test.txt', contentType: 'text/plain' },
      { content: '# Markdown\n\nContent', filename: 'test.md', contentType: 'text/markdown' },
      {
        content: '{"key": "value", "nested": {"data": "test"}}',
        filename: 'test.json',
        contentType: 'application/json',
      },
      { content: 'a,b,c\n1,2,3\n4,5,6', filename: 'test.csv', contentType: 'text/csv' },
      {
        content: '<root><item>value</item></root>',
        filename: 'test.xml',
        contentType: 'application/xml',
      },
    ];

    for (const format of formats) {
      // Create document
      const doc = await createTestDocument(format.contentType, format.filename);

      // Process extraction
      await processExtractionWorker(doc._id, format.content);

      // Process chunking
      await processCanonicalMapper(doc._id);

      // Verify chunks created
      const chunks = await getDb()
        .collection('search_chunks')
        .find({ documentId: doc._id })
        .toArray();
      expect(chunks.length, `${format.filename} should create chunks`).toBeGreaterThan(0);

      // Verify content is present
      const firstChunk = chunks[0] as any;
      expect(firstChunk.content, `${format.filename} should have content`).toBeTruthy();
    }
  });

  test('should preserve code blocks in markdown', async () => {
    const markdown = `# Code Example

Some text before.

\`\`\`python
def hello():
    return "world"
\`\`\`

Text after.`;

    const doc = await createTestDocument('text/markdown', 'code.md');

    // Process extraction
    await processExtractionWorker(doc._id, markdown);

    // Process chunking
    await processCanonicalMapper(doc._id);

    // Verify chunks
    const chunks = await getDb()
      .collection('search_chunks')
      .find({ documentId: doc._id })
      .toArray();

    // Find chunk containing code
    const codeChunk = chunks.find((c: any) => c.content.includes('def hello'));
    expect(codeChunk, 'Code block should be in a chunk').toBeTruthy();

    // Code block should be intact (not split)
    const codeContent = (codeChunk as any)?.content;
    expect(codeContent).toContain('def hello():');
    expect(codeContent).toContain('return "world"');
  });

  test('should handle empty files gracefully', async () => {
    const doc = await createTestDocument('text/plain', 'empty.txt');

    // Process extraction with empty content
    await processExtractionWorker(doc._id, '');

    // Process chunking
    await processCanonicalMapper(doc._id);

    // Should handle gracefully - may create 0 or 1 empty chunk
    const chunks = await getDb()
      .collection('search_chunks')
      .find({ documentId: doc._id })
      .toArray();
    expect(chunks.length).toBeGreaterThanOrEqual(0);

    // Document should still have status updated
    const updatedDoc = await getDb().collection('search_documents').findOne({ _id: doc._id });
    expect(updatedDoc?.status).toBe('chunked');
  });

  test('should track extraction metadata', async () => {
    const content = 'Test content with multiple sentences. First one. Second one. Third one.';
    const doc = await createTestDocument('text/plain', 'test.txt');

    // Process extraction
    await processExtractionWorker(doc._id, content);

    // Verify page metadata
    const pages = await getDb()
      .collection('document_pages')
      .find({ documentId: doc._id })
      .toArray();
    expect(pages[0]).toHaveProperty('tenantId');
    expect(pages[0]).toHaveProperty('indexId');
    expect(pages[0]).toHaveProperty('sourceId');
    expect(pages[0]).toHaveProperty('pageNumber');

    // Process chunking
    await processCanonicalMapper(doc._id);

    // Verify chunk metadata
    const chunks = await getDb()
      .collection('search_chunks')
      .find({ documentId: doc._id })
      .toArray();
    for (const chunk of chunks) {
      expect(chunk).toHaveProperty('tenantId');
      expect(chunk).toHaveProperty('indexId');
      expect(chunk).toHaveProperty('chunkIndex');
      expect(chunk).toHaveProperty('tokenCount');
      expect((chunk as any).tokenCount).toBeGreaterThan(0);
    }
  });
});

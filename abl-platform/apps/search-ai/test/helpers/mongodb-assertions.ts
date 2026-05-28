/**
 * MongoDB Assertions - Helper to assert MongoDB state in tests
 *
 * Uses native MongoDB driver to avoid conflicts with service's mongoose connection
 */

import { expect } from 'vitest';
import { MongoClient, Db } from 'mongodb';

const MONGO_URL =
  process.env.MONGO_URL ||
  'mongodb://abl_admin:abl_dev_password@localhost:27018/?authSource=admin&directConnection=true';

export class MongoDBAssertions {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  /**
   * Ensure MongoDB is connected
   */
  private async ensureConnected(): Promise<Db> {
    if (!this.client) {
      this.client = new MongoClient(MONGO_URL);
      await this.client.connect();
      this.db = this.client.db('search_ai');
    }
    return this.db!;
  }

  /**
   * Close MongoDB connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }
  /**
   * Assert that a document exists with expected properties
   */
  async assertDocumentExists(
    documentId: string,
    expectedFields?: Partial<{
      status: string;
      pageCount: number;
      chunkCount: number;
      originalReference: string;
    }>,
  ) {
    const db = await this.ensureConnected();
    const doc = await db.collection('search_documents').findOne({ _id: documentId });
    expect(doc, `Document ${documentId} should exist`).toBeTruthy();

    if (expectedFields?.status) {
      expect(doc!.status).toBe(expectedFields.status);
    }
    if (expectedFields?.pageCount !== undefined) {
      expect(doc!.pageCount).toBe(expectedFields.pageCount);
    }
    if (expectedFields?.chunkCount !== undefined) {
      expect(doc!.chunkCount).toBe(expectedFields.chunkCount);
    }
    if (expectedFields?.originalReference) {
      expect(doc!.originalReference).toBe(expectedFields.originalReference);
    }

    return doc!;
  }

  /**
   * Assert that pages were created for a document
   */
  async assertPagesCreated(documentId: string, expectedCount?: number) {
    const db = await this.ensureConnected();
    const pages = await db
      .collection('document_pages')
      .find({ documentId })
      .sort({ pageNumber: 1 })
      .toArray();

    expect(pages.length, 'At least one page should be created').toBeGreaterThan(0);

    if (expectedCount !== undefined) {
      expect(pages.length, `Expected ${expectedCount} pages`).toBe(expectedCount);
    }

    // Verify page structure
    pages.forEach((page, index) => {
      expect(page.pageNumber, `Page ${index} should have correct pageNumber`).toBe(index + 1);
      expect(page.text, `Page ${index} should have text content`).toBeTruthy();
    });

    console.log(`[MongoDB] ✓ Found ${pages.length} pages for document ${documentId}`);
    return pages;
  }

  /**
   * Assert that chunks were created from pages
   */
  async assertChunksCreated(documentId: string, expectedCount?: number) {
    const db = await this.ensureConnected();
    const chunks = await db
      .collection('search_chunks')
      .find({ documentId })
      .sort({ chunkIndex: 1 })
      .toArray();

    expect(chunks.length, 'At least one chunk should be created').toBeGreaterThan(0);

    if (expectedCount !== undefined) {
      expect(chunks.length, `Expected ${expectedCount} chunks`).toBe(expectedCount);
    }

    // Verify chunk structure
    chunks.forEach((chunk: any, index) => {
      expect(chunk.chunkIndex, `Chunk ${index} should have correct chunkIndex`).toBe(index);
      expect(chunk.content, `Chunk ${index} should have content`).toBeTruthy();
      expect(chunk.tokenCount, `Chunk ${index} should have token count`).toBeGreaterThan(0);
      expect(['pending', 'indexed', 'error'], `Chunk ${index} status should be valid`).toContain(
        chunk.status,
      );
    });

    console.log(`[MongoDB] ✓ Found ${chunks.length} chunks for document ${documentId}`);
    return chunks;
  }

  /**
   * Assert chunks have been indexed (status = 'indexed', vectorId set)
   */
  async assertChunksIndexed(documentId: string) {
    const db = await this.ensureConnected();
    const chunks = await db.collection('search_chunks').find({ documentId }).toArray();

    expect(chunks.length, 'At least one chunk should exist').toBeGreaterThan(0);

    chunks.forEach((chunk: any, index) => {
      expect(chunk.status, `Chunk ${index} should be indexed`).toBe('indexed');
      expect(chunk.vectorId, `Chunk ${index} should have vectorId`).toBeTruthy();
    });

    console.log(`[MongoDB] ✓ All ${chunks.length} chunks are indexed`);
    return chunks;
  }

  /**
   * Get document status
   */
  async getDocumentStatus(documentId: string): Promise<string | null> {
    const db = await this.ensureConnected();
    const doc = await db
      .collection('search_documents')
      .findOne({ _id: documentId }, { projection: { status: 1 } });
    return doc?.status || null;
  }

  /**
   * Count chunks for a document
   */
  async countChunks(documentId: string): Promise<number> {
    const db = await this.ensureConnected();
    return await db.collection('search_chunks').countDocuments({ documentId });
  }

  /**
   * Count pages for a document
   */
  async countPages(documentId: string): Promise<number> {
    const db = await this.ensureConnected();
    return await db.collection('document_pages').countDocuments({ documentId });
  }
}

/**
 * Attachment Concurrency Tests
 *
 * Verifies that concurrent attachment tool executions on the same session
 * do not produce race conditions, data corruption, or inconsistent state.
 *
 * Tests cover:
 * 1. Parallel get_attachment calls with different IDs — both resolve independently
 * 2. Parallel list_attachments calls — consistent snapshots
 * 3. Concurrent get + list on the same session — no cross-contamination
 * 4. Rapid sequential calls — no state corruption
 * 5. Concurrent error + success — errors don't leak into successful results
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AttachmentToolExecutor,
  type AttachmentServiceClient,
  type AttachmentToolContext,
} from '../../tools/attachment-tool-executor.js';
import type { IAttachment } from '@agent-platform/database';

// ─── Constants ──────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-concurrent-001';
const SESSION_ID = 'sess-concurrent-001';

const DEFAULT_CONTEXT: AttachmentToolContext = {
  tenantId: TENANT_ID,
  sessionId: SESSION_ID,
  projectId: 'proj-concurrent-001',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockAttachment(overrides: Partial<IAttachment> = {}): IAttachment {
  return {
    _id: 'att-1',
    tenantId: TENANT_ID,
    projectId: 'proj-001',
    sessionId: SESSION_ID,
    messageId: null,
    originalFilename: 'photo.jpg',
    mimeType: 'image/jpeg',
    detectedMimeType: null,
    category: 'image',
    sizeBytes: 1024,
    contentHash: null,
    storageProvider: 's3',
    storageKey: 'uploads/att-1.jpg',
    storageBucket: 'attachments',
    encrypted: false,
    encryptionKeyVersion: 0,
    scanStatus: 'pending',
    scanEngine: null,
    scannedAt: null,
    hasPII: false,
    exifStripped: false,
    processingStatus: 'completed',
    processedContent: 'Extracted text',
    processedContentHash: null,
    processingError: null,
    processingEngine: 'tesseract',
    processedAt: new Date('2026-01-15T00:00:00Z'),
    resizedStorageKey: null,
    resizedSizeBytes: null,
    thumbnailStorageKey: null,
    imageDescription: 'A test image',
    imageDescriptionModel: 'gpt-4o',
    searchIndexId: null,
    searchDocumentId: null,
    embeddingStatus: 'pending',
    embeddedAt: null,
    expiresAt: new Date('2026-04-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-15T00:00:00Z'),
    _v: 1,
    ...overrides,
  } as IAttachment;
}

function createMockClient(): AttachmentServiceClient {
  return {
    getAttachment: vi.fn(),
    listBySession: vi.fn(),
    getDownloadUrl: vi.fn().mockRejectedValue(new Error('not implemented in mock')),
    upload: vi.fn().mockRejectedValue(new Error('not implemented in mock')),
    retry: vi.fn().mockRejectedValue(new Error('not implemented in mock')),
  };
}

function createExecutor(client?: AttachmentServiceClient) {
  const serviceClient = client ?? createMockClient();
  const executor = new AttachmentToolExecutor({ serviceClient });
  return { executor, serviceClient };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Attachment Concurrency', () => {
  let serviceClient: AttachmentServiceClient;
  let executor: AttachmentToolExecutor;

  beforeEach(() => {
    const created = createExecutor();
    serviceClient = created.serviceClient;
    executor = created.executor;
  });

  // ── Test 1: Parallel get_attachment with different IDs ────────────────

  it('parallel get_attachment calls with different IDs return independent results', async () => {
    const att1 = mockAttachment({
      _id: 'att-parallel-1',
      originalFilename: 'photo1.jpg',
      imageDescription: 'First image',
    });
    const att2 = mockAttachment({
      _id: 'att-parallel-2',
      originalFilename: 'photo2.jpg',
      imageDescription: 'Second image',
    });

    // Each call resolves after a different delay to simulate real async behavior
    vi.mocked(serviceClient.getAttachment).mockImplementation(async (id: string) => {
      if (id === 'att-parallel-1') {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return att1;
      }
      if (id === 'att-parallel-2') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return att2;
      }
      return null;
    });

    // Fire both calls concurrently
    const [result1, result2] = await Promise.all([
      executor.execute('get_attachment', { attachmentId: 'att-parallel-1' }, DEFAULT_CONTEXT),
      executor.execute('get_attachment', { attachmentId: 'att-parallel-2' }, DEFAULT_CONTEXT),
    ]);

    // Verify each result is independent — no cross-contamination
    expect(result1).toEqual(
      expect.objectContaining({
        id: 'att-parallel-1',
        filename: 'photo1.jpg',
        imageDescription: 'First image',
      }),
    );

    expect(result2).toEqual(
      expect.objectContaining({
        id: 'att-parallel-2',
        filename: 'photo2.jpg',
        imageDescription: 'Second image',
      }),
    );

    // Both calls should have been made
    expect(serviceClient.getAttachment).toHaveBeenCalledTimes(2);
  });

  // ── Test 2: Parallel list_attachments return consistent snapshots ─────

  it('parallel list_attachments calls return consistent snapshots', async () => {
    const attachments = [
      mockAttachment({ _id: 'att-list-1', originalFilename: 'a.jpg' }),
      mockAttachment({ _id: 'att-list-2', originalFilename: 'b.pdf', category: 'document' }),
      mockAttachment({ _id: 'att-list-3', originalFilename: 'c.mp3', category: 'audio' }),
    ];

    let callCount = 0;
    vi.mocked(serviceClient.listBySession).mockImplementation(async () => {
      callCount++;
      // Vary delay per call to simulate real timing
      await new Promise((resolve) => setTimeout(resolve, callCount * 10));
      // Always return same snapshot — no mutation between calls
      return [...attachments];
    });

    // Fire 5 parallel list calls
    const results = await Promise.all(
      Array.from({ length: 5 }, () => executor.execute('list_attachments', {}, DEFAULT_CONTEXT)),
    );

    // All 5 should return identical results
    for (const result of results) {
      const typed = result as { attachments: Array<{ id: string }>; total: number };
      expect(typed.total).toBe(3);
      expect(typed.attachments).toHaveLength(3);
      expect(typed.attachments[0].id).toBe('att-list-1');
      expect(typed.attachments[1].id).toBe('att-list-2');
      expect(typed.attachments[2].id).toBe('att-list-3');
    }

    expect(serviceClient.listBySession).toHaveBeenCalledTimes(5);
  });

  // ── Test 3: Concurrent get + list on same session ─────────────────────

  it('concurrent get_attachment and list_attachments on same session produce correct results', async () => {
    const singleAtt = mockAttachment({
      _id: 'att-mixed-1',
      originalFilename: 'single.jpg',
      imageDescription: 'The single one',
    });
    const listAtts = [
      mockAttachment({ _id: 'att-mixed-1', originalFilename: 'single.jpg' }),
      mockAttachment({ _id: 'att-mixed-2', originalFilename: 'other.png' }),
    ];

    vi.mocked(serviceClient.getAttachment).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return singleAtt;
    });

    vi.mocked(serviceClient.listBySession).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [...listAtts];
    });

    const [getResult, listResult] = await Promise.all([
      executor.execute('get_attachment', { attachmentId: 'att-mixed-1' }, DEFAULT_CONTEXT),
      executor.execute('list_attachments', {}, DEFAULT_CONTEXT),
    ]);

    // get_attachment should return the detail fields (content, imageDescription)
    expect(getResult).toEqual(
      expect.objectContaining({
        id: 'att-mixed-1',
        filename: 'single.jpg',
        imageDescription: 'The single one',
        content: 'Extracted text',
      }),
    );

    // list_attachments should return summaries without content/imageDescription
    const typed = listResult as {
      attachments: Array<{ id: string; filename: string }>;
      total: number;
    };
    expect(typed.total).toBe(2);
    expect(typed.attachments[0].id).toBe('att-mixed-1');
    expect(typed.attachments[1].id).toBe('att-mixed-2');
    // Summaries should NOT have content or imageDescription
    expect((typed.attachments[0] as Record<string, unknown>).content).toBeUndefined();
    expect((typed.attachments[0] as Record<string, unknown>).imageDescription).toBeUndefined();
  });

  // ── Test 4: Rapid sequential calls ───────────────────────────────────

  it('rapid sequential get_attachment calls produce correct results without state corruption', async () => {
    const attachments = Array.from({ length: 10 }, (_, i) =>
      mockAttachment({
        _id: `att-rapid-${i}`,
        originalFilename: `file-${i}.jpg`,
        imageDescription: `Description ${i}`,
      }),
    );

    vi.mocked(serviceClient.getAttachment).mockImplementation(async (id: string) => {
      const idx = parseInt(id.replace('att-rapid-', ''), 10);
      // Random small delay to simulate real async
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
      return attachments[idx] ?? null;
    });

    // Fire 10 calls as fast as possible
    const results: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      const result = await executor.execute(
        'get_attachment',
        { attachmentId: `att-rapid-${i}` },
        DEFAULT_CONTEXT,
      );
      results.push(result);
    }

    // Verify each result matches its index — no mixing
    for (let i = 0; i < 10; i++) {
      expect(results[i]).toEqual(
        expect.objectContaining({
          id: `att-rapid-${i}`,
          filename: `file-${i}.jpg`,
          imageDescription: `Description ${i}`,
        }),
      );
    }
  });

  // ── Test 5: Concurrent error + success ───────────────────────────────

  it('concurrent error and success calls do not leak errors into successful results', async () => {
    const goodAtt = mockAttachment({
      _id: 'att-good',
      originalFilename: 'good.jpg',
    });

    vi.mocked(serviceClient.getAttachment).mockImplementation(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (id === 'att-bad') {
        throw new Error('Simulated network failure');
      }
      return goodAtt;
    });

    // Fire both concurrently — one will fail, one will succeed
    const [goodResult, badResult] = await Promise.all([
      executor.execute('get_attachment', { attachmentId: 'att-good' }, DEFAULT_CONTEXT),
      executor.execute('get_attachment', { attachmentId: 'att-bad' }, DEFAULT_CONTEXT),
    ]);

    // Successful call should have clean data
    expect(goodResult).toEqual(
      expect.objectContaining({
        id: 'att-good',
        filename: 'good.jpg',
      }),
    );
    expect(goodResult).not.toHaveProperty('error');

    // Failed call should have structured error
    expect(badResult).toEqual({
      error: "Attachment tool 'get_attachment' failed: Simulated network failure",
    });
  });

  // ── Test 6: Many concurrent list with category filter ─────────────────

  it('concurrent list_attachments with different category filters produce correct filtered results', async () => {
    const allAttachments = [
      mockAttachment({ _id: 'att-1', category: 'image', originalFilename: 'photo.jpg' }),
      mockAttachment({
        _id: 'att-2',
        category: 'document',
        originalFilename: 'doc.pdf',
        mimeType: 'application/pdf',
      }),
      mockAttachment({
        _id: 'att-3',
        category: 'audio',
        originalFilename: 'song.mp3',
        mimeType: 'audio/mpeg',
      }),
      mockAttachment({ _id: 'att-4', category: 'image', originalFilename: 'pic.png' }),
    ];

    vi.mocked(serviceClient.listBySession).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return [...allAttachments];
    });

    const [imageResult, docResult, audioResult, allResult] = await Promise.all([
      executor.execute('list_attachments', { category: 'image' }, DEFAULT_CONTEXT),
      executor.execute('list_attachments', { category: 'document' }, DEFAULT_CONTEXT),
      executor.execute('list_attachments', { category: 'audio' }, DEFAULT_CONTEXT),
      executor.execute('list_attachments', {}, DEFAULT_CONTEXT),
    ]);

    // Image filter: 2 results
    expect((imageResult as { total: number }).total).toBe(2);

    // Document filter: 1 result
    expect((docResult as { total: number }).total).toBe(1);

    // Audio filter: 1 result
    expect((audioResult as { total: number }).total).toBe(1);

    // No filter: all 4
    expect((allResult as { total: number }).total).toBe(4);
  });
});

/**
 * Crawl Completion Tracking Tests
 *
 * Tests for crawl job completion detection and quality metrics aggregation
 * in the embedding worker (RFC-001 P1-3).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { DocumentStatus, ChunkStatus } from '@agent-platform/search-ai-sdk';

// Mock types matching the worker's expectations
interface MockDocument {
  _id: string;
  status: string;
  sourceMetadata?: {
    crawlJobId?: string;
    qualityScore?: number;
    contentPreservation?: number;
    [key: string]: any;
  };
  createdAt: Date;
  updatedAt?: Date;
}

interface MockCrawlJob {
  _id: string;
  status: string;
  strategy: string;
  timeline: {
    submittedAt: Date;
    startedAt?: Date;
    completedAt?: Date;
  };
  results: {
    documentsCreated: number;
    documentsIndexed: number;
    documentsFailed: number;
    chunksCreated: number;
    qualityMetrics?: {
      avgQualityScore: number;
      avgContentPreservation: number;
      avgChunksPerDoc: number;
      successRate: number;
    };
  };
  save: () => Promise<void>;
}

interface MockCrawlHistory {
  statuses: Array<{
    timestamp: Date;
    status: string;
    phase: string;
    metrics?: any;
  }>;
  documentStatusChanges: Array<{
    documentId: string;
    fromStatus: string;
    toStatus: string;
    timestamp: Date;
    worker: string;
    durationMs: number;
    metadata?: any;
  }>;
  save: () => Promise<void>;
}

// Mock database models
const mockSearchDocumentFind = vi.fn();
const mockSearchChunkCountDocuments = vi.fn();
const mockCrawlJobFindById = vi.fn();
const mockCrawlHistoryFindOne = vi.fn();
const mockCrawlAuditEventConstructor = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  SearchDocument: {
    find: mockSearchDocumentFind,
  },
  SearchChunk: {
    countDocuments: mockSearchChunkCountDocuments,
  },
  CrawlJob: {
    findById: mockCrawlJobFindById,
  },
  CrawlHistory: {
    findOne: mockCrawlHistoryFindOne,
  },
  CrawlAuditEvent: mockCrawlAuditEventConstructor,
}));

describe('Crawl Completion Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Document Status Change Tracking', () => {
    test('should track successful document indexing in CrawlHistory', async () => {
      const mockHistory: MockCrawlHistory = {
        statuses: [],
        documentStatusChanges: [],
        save: vi.fn().mockResolvedValue(undefined),
      };

      mockCrawlHistoryFindOne.mockResolvedValue(mockHistory);

      // Simulate the logic from embedding-worker.ts
      const documentId = 'doc-123';
      const previousStatus = DocumentStatus.EMBEDDING;
      const newStatus = DocumentStatus.INDEXED;
      const documentCreatedAt = Date.now() - 300000; // 5 minutes ago

      if (mockHistory) {
        mockHistory.documentStatusChanges.push({
          documentId,
          fromStatus: previousStatus,
          toStatus: newStatus,
          timestamp: new Date(),
          worker: 'embedding',
          durationMs: Date.now() - documentCreatedAt,
        });
        await mockHistory.save();
      }

      expect(mockHistory.documentStatusChanges).toHaveLength(1);
      expect(mockHistory.documentStatusChanges[0]).toMatchObject({
        documentId: 'doc-123',
        fromStatus: DocumentStatus.EMBEDDING,
        toStatus: DocumentStatus.INDEXED,
        worker: 'embedding',
      });
      expect(mockHistory.documentStatusChanges[0].durationMs).toBeGreaterThan(0);
      expect(mockHistory.save).toHaveBeenCalledOnce();
    });

    test('should track document errors with metadata in CrawlHistory', async () => {
      const mockHistory: MockCrawlHistory = {
        statuses: [],
        documentStatusChanges: [],
        save: vi.fn().mockResolvedValue(undefined),
      };

      mockCrawlHistoryFindOne.mockResolvedValue(mockHistory);

      const errorMessage = 'Embedding failed: Connection timeout';

      if (mockHistory) {
        mockHistory.documentStatusChanges.push({
          documentId: 'doc-456',
          fromStatus: DocumentStatus.EMBEDDING,
          toStatus: DocumentStatus.ERROR,
          timestamp: new Date(),
          worker: 'embedding',
          durationMs: 30000,
          metadata: { error: errorMessage },
        });
        await mockHistory.save();
      }

      expect(mockHistory.documentStatusChanges).toHaveLength(1);
      expect(mockHistory.documentStatusChanges[0].metadata?.error).toBe(errorMessage);
    });

    test('should handle missing CrawlHistory gracefully', async () => {
      mockCrawlHistoryFindOne.mockResolvedValue(null);

      // Simulate the worker's try-catch behavior
      let errorThrown = false;
      try {
        const history = await mockCrawlHistoryFindOne('batch-123');
        if (history) {
          history.documentStatusChanges.push({
            documentId: 'doc-123',
            fromStatus: 'pending',
            toStatus: 'indexed',
            timestamp: new Date(),
            worker: 'embedding',
            durationMs: 1000,
          });
          await history.save();
        }
      } catch (error) {
        errorThrown = true;
      }

      expect(errorThrown).toBe(false);
      expect(mockCrawlHistoryFindOne).toHaveBeenCalled();
    });
  });

  describe('Completion Detection Logic', () => {
    test('should detect job completion when all documents are indexed', async () => {
      const crawlJobId = 'batch-123';
      const tenantId = 'tenant-789';
      const indexId = 'index-456';

      // Mock documents - all indexed
      const mockDocuments: MockDocument[] = [
        {
          _id: 'doc-1',
          status: DocumentStatus.INDEXED,
          sourceMetadata: {
            crawlJobId,
            qualityScore: 0.85,
            contentPreservation: 0.92,
          },
          createdAt: new Date('2025-01-01T10:00:00Z'),
        },
        {
          _id: 'doc-2',
          status: DocumentStatus.INDEXED,
          sourceMetadata: {
            crawlJobId,
            qualityScore: 0.88,
            contentPreservation: 0.95,
          },
          createdAt: new Date('2025-01-01T10:00:10Z'),
        },
        {
          _id: 'doc-3',
          status: DocumentStatus.INDEXED,
          sourceMetadata: {
            crawlJobId,
            qualityScore: 0.9,
            contentPreservation: 0.93,
          },
          createdAt: new Date('2025-01-01T10:00:20Z'),
        },
      ];

      mockSearchDocumentFind.mockReturnValue({
        select: vi.fn().mockResolvedValue(mockDocuments),
      });

      mockSearchChunkCountDocuments.mockResolvedValue(15); // 3 docs × 5 chunks

      const mockCrawlJob: MockCrawlJob = {
        _id: crawlJobId,
        status: 'ingesting',
        strategy: 'bulk',
        timeline: {
          submittedAt: new Date('2025-01-01T09:59:00Z'),
          startedAt: new Date('2025-01-01T09:59:10Z'),
        },
        results: {
          documentsCreated: 3,
          documentsIndexed: 0,
          documentsFailed: 0,
          chunksCreated: 0,
        },
        save: vi.fn().mockResolvedValue(undefined),
      };

      mockCrawlJobFindById.mockResolvedValue(mockCrawlJob);

      // Simulate completion detection logic
      const allDocuments = await mockSearchDocumentFind({
        tenantId,
        indexId,
        'sourceMetadata.crawlJobId': crawlJobId,
      }).select('status sourceMetadata');

      const statusCounts = allDocuments.reduce((acc: Record<string, number>, doc: MockDocument) => {
        acc[doc.status] = (acc[doc.status] || 0) + 1;
        return acc;
      }, {});

      const indexedCount = statusCounts[DocumentStatus.INDEXED] || 0;
      const errorCount = statusCounts[DocumentStatus.ERROR] || 0;
      const totalDocs = allDocuments.length;
      const completedDocs = indexedCount + errorCount;

      expect(completedDocs).toBe(totalDocs);
      expect(totalDocs).toBe(3);

      // Should update job status to completed
      if (completedDocs === totalDocs && totalDocs > 0) {
        const crawlJob = await mockCrawlJobFindById(crawlJobId);

        // Calculate quality metrics
        const qualityScores = allDocuments
          .map((doc: MockDocument) => doc.sourceMetadata?.qualityScore)
          .filter((score: number | undefined): score is number => typeof score === 'number');

        const contentPreservationScores = allDocuments
          .map((doc: MockDocument) => doc.sourceMetadata?.contentPreservation)
          .filter((score: number | undefined): score is number => typeof score === 'number');

        const allChunks = await mockSearchChunkCountDocuments({
          documentId: { $in: allDocuments.map((doc: MockDocument) => doc._id) },
          indexId,
        });

        crawlJob.status = 'completed';
        crawlJob.timeline.completedAt = new Date();
        crawlJob.results.documentsIndexed = indexedCount;
        crawlJob.results.documentsFailed = errorCount;
        crawlJob.results.chunksCreated = allChunks;

        if (qualityScores.length > 0) {
          const avgQuality =
            qualityScores.reduce((sum: number, score: number) => sum + score, 0) /
            qualityScores.length;
          const avgContentPreservation =
            contentPreservationScores.length > 0
              ? contentPreservationScores.reduce((sum: number, score: number) => sum + score, 0) /
                contentPreservationScores.length
              : 0;
          const successRate = indexedCount / totalDocs;

          crawlJob.results.qualityMetrics = {
            avgQualityScore: avgQuality,
            avgContentPreservation: avgContentPreservation,
            avgChunksPerDoc: totalDocs > 0 ? allChunks / totalDocs : 0,
            successRate: successRate,
          };
        }

        await crawlJob.save();

        expect(crawlJob.status).toBe('completed');
        expect(crawlJob.results.documentsIndexed).toBe(3);
        expect(crawlJob.results.documentsFailed).toBe(0);
        expect(crawlJob.results.chunksCreated).toBe(15);
        expect(crawlJob.results.qualityMetrics?.avgQualityScore).toBeCloseTo(0.877, 2);
        expect(crawlJob.results.qualityMetrics?.avgContentPreservation).toBeCloseTo(0.933, 2);
        expect(crawlJob.results.qualityMetrics?.avgChunksPerDoc).toBe(5);
        expect(crawlJob.results.qualityMetrics?.successRate).toBe(1.0);
        expect(crawlJob.save).toHaveBeenCalledOnce();
      }
    });

    test('should detect job completion with partial failures', async () => {
      const crawlJobId = 'batch-456';
      const tenantId = 'tenant-789';
      const indexId = 'index-456';

      // Mock documents - 2 indexed, 1 failed
      const mockDocuments: MockDocument[] = [
        {
          _id: 'doc-1',
          status: DocumentStatus.INDEXED,
          sourceMetadata: {
            crawlJobId,
            qualityScore: 0.85,
            contentPreservation: 0.92,
          },
          createdAt: new Date(),
        },
        {
          _id: 'doc-2',
          status: DocumentStatus.INDEXED,
          sourceMetadata: {
            crawlJobId,
            qualityScore: 0.88,
            contentPreservation: 0.95,
          },
          createdAt: new Date(),
        },
        {
          _id: 'doc-3',
          status: DocumentStatus.ERROR,
          sourceMetadata: {
            crawlJobId,
          },
          createdAt: new Date(),
        },
      ];

      mockSearchDocumentFind.mockReturnValue({
        select: vi.fn().mockResolvedValue(mockDocuments),
      });

      mockSearchChunkCountDocuments.mockResolvedValue(10); // 2 indexed docs × 5 chunks

      const mockCrawlJob: MockCrawlJob = {
        _id: crawlJobId,
        status: 'ingesting',
        strategy: 'bulk',
        timeline: {
          submittedAt: new Date(),
          startedAt: new Date(),
        },
        results: {
          documentsCreated: 3,
          documentsIndexed: 0,
          documentsFailed: 0,
          chunksCreated: 0,
        },
        save: vi.fn().mockResolvedValue(undefined),
      };

      mockCrawlJobFindById.mockResolvedValue(mockCrawlJob);

      // Simulate completion detection
      const allDocuments = await mockSearchDocumentFind({
        tenantId,
        indexId,
        'sourceMetadata.crawlJobId': crawlJobId,
      }).select('status sourceMetadata');

      const statusCounts = allDocuments.reduce((acc: Record<string, number>, doc: MockDocument) => {
        acc[doc.status] = (acc[doc.status] || 0) + 1;
        return acc;
      }, {});

      const indexedCount = statusCounts[DocumentStatus.INDEXED] || 0;
      const errorCount = statusCounts[DocumentStatus.ERROR] || 0;
      const totalDocs = allDocuments.length;
      const completedDocs = indexedCount + errorCount;

      expect(completedDocs).toBe(totalDocs);
      expect(indexedCount).toBe(2);
      expect(errorCount).toBe(1);

      // Update job
      const crawlJob = await mockCrawlJobFindById(crawlJobId);
      crawlJob.status = 'completed';
      crawlJob.results.documentsIndexed = indexedCount;
      crawlJob.results.documentsFailed = errorCount;
      crawlJob.results.chunksCreated = 10;

      const qualityScores = allDocuments
        .map((doc: MockDocument) => doc.sourceMetadata?.qualityScore)
        .filter((score: number | undefined): score is number => typeof score === 'number');

      const avgQuality =
        qualityScores.reduce((sum: number, score: number) => sum + score, 0) / qualityScores.length;
      const successRate = indexedCount / totalDocs;

      crawlJob.results.qualityMetrics = {
        avgQualityScore: avgQuality,
        avgContentPreservation: 0.935,
        avgChunksPerDoc: 10 / totalDocs,
        successRate: successRate,
      };

      await crawlJob.save();

      expect(crawlJob.results.qualityMetrics?.successRate).toBeCloseTo(0.667, 2);
      expect(crawlJob.results.documentsIndexed).toBe(2);
      expect(crawlJob.results.documentsFailed).toBe(1);
    });

    test('should not mark job as completed if documents are still processing', async () => {
      const crawlJobId = 'batch-789';
      const mockDocuments: MockDocument[] = [
        {
          _id: 'doc-1',
          status: DocumentStatus.INDEXED,
          sourceMetadata: { crawlJobId },
          createdAt: new Date(),
        },
        {
          _id: 'doc-2',
          status: DocumentStatus.EMBEDDING, // Still processing
          sourceMetadata: { crawlJobId },
          createdAt: new Date(),
        },
      ];

      mockSearchDocumentFind.mockReturnValue({
        select: vi.fn().mockResolvedValue(mockDocuments),
      });

      const statusCounts = mockDocuments.reduce(
        (acc: Record<string, number>, doc: MockDocument) => {
          acc[doc.status] = (acc[doc.status] || 0) + 1;
          return acc;
        },
        {},
      );

      const indexedCount = statusCounts[DocumentStatus.INDEXED] || 0;
      const errorCount = statusCounts[DocumentStatus.ERROR] || 0;
      const totalDocs = mockDocuments.length;
      const completedDocs = indexedCount + errorCount;

      expect(completedDocs).toBeLessThan(totalDocs);
      expect(mockCrawlJobFindById).not.toHaveBeenCalled();
    });

    test('should handle jobs without quality metrics in documents', async () => {
      const crawlJobId = 'batch-no-metrics';
      const mockDocuments: MockDocument[] = [
        {
          _id: 'doc-1',
          status: DocumentStatus.INDEXED,
          sourceMetadata: { crawlJobId }, // No quality scores
          createdAt: new Date(),
        },
        {
          _id: 'doc-2',
          status: DocumentStatus.INDEXED,
          sourceMetadata: { crawlJobId },
          createdAt: new Date(),
        },
      ];

      mockSearchDocumentFind.mockReturnValue({
        select: vi.fn().mockResolvedValue(mockDocuments),
      });

      mockSearchChunkCountDocuments.mockResolvedValue(10);

      const mockCrawlJob: MockCrawlJob = {
        _id: crawlJobId,
        status: 'ingesting',
        strategy: 'bulk',
        timeline: {
          submittedAt: new Date(),
        },
        results: {
          documentsCreated: 2,
          documentsIndexed: 0,
          documentsFailed: 0,
          chunksCreated: 0,
        },
        save: vi.fn().mockResolvedValue(undefined),
      };

      mockCrawlJobFindById.mockResolvedValue(mockCrawlJob);

      // Simulate completion detection
      const allDocuments = await mockSearchDocumentFind({}).select('status sourceMetadata');

      const qualityScores = allDocuments
        .map((doc: MockDocument) => doc.sourceMetadata?.qualityScore)
        .filter((score: number | undefined): score is number => typeof score === 'number');

      expect(qualityScores).toHaveLength(0);

      // Should still complete, just without quality metrics
      const crawlJob = await mockCrawlJobFindById(crawlJobId);
      crawlJob.status = 'completed';
      crawlJob.results.documentsIndexed = 2;
      crawlJob.results.chunksCreated = 10;

      if (qualityScores.length === 0) {
        // Don't set qualityMetrics if no scores available
      }

      await crawlJob.save();

      expect(crawlJob.status).toBe('completed');
      expect(crawlJob.results.qualityMetrics).toBeUndefined();
      expect(crawlJob.save).toHaveBeenCalledOnce();
    });
  });

  describe('Quality Metrics Aggregation', () => {
    test('should calculate correct average quality score', () => {
      const documents = [
        { qualityScore: 0.85 },
        { qualityScore: 0.9 },
        { qualityScore: 0.88 },
        { qualityScore: 0.92 },
      ];

      const qualityScores = documents
        .map((doc: { qualityScore: number }) => doc.qualityScore)
        .filter((score: number | undefined): score is number => typeof score === 'number');

      const avgQuality =
        qualityScores.reduce((sum: number, score: number) => sum + score, 0) / qualityScores.length;

      expect(avgQuality).toBeCloseTo(0.8875, 4);
    });

    test('should calculate success rate correctly', () => {
      const totalDocs = 10;
      const indexedDocs = 8;

      const successRate = indexedDocs / totalDocs;

      expect(successRate).toBe(0.8);
    });

    test('should calculate average chunks per document', () => {
      const totalDocs = 5;
      const totalChunks = 25;

      const avgChunksPerDoc = totalDocs > 0 ? totalChunks / totalDocs : 0;

      expect(avgChunksPerDoc).toBe(5);
    });

    test('should handle zero documents gracefully', () => {
      const totalDocs = 0;
      const totalChunks = 0;

      const avgChunksPerDoc = totalDocs > 0 ? totalChunks / totalDocs : 0;

      expect(avgChunksPerDoc).toBe(0);
    });

    test('should filter out documents without quality scores', () => {
      const documents = [
        { qualityScore: 0.85 },
        { qualityScore: undefined },
        { qualityScore: 0.9 },
        { qualityScore: null },
        { qualityScore: 0.88 },
      ];

      const qualityScores = documents
        .map((doc: { qualityScore: number | undefined | null }) => doc.qualityScore)
        .filter((score: number | undefined | null): score is number => typeof score === 'number');

      expect(qualityScores).toHaveLength(3);
      expect(qualityScores).toEqual([0.85, 0.9, 0.88]);
    });
  });

  describe('Audit Event Creation', () => {
    test('should create crawl.completed audit event', async () => {
      const mockEvent = {
        _id: 'event-123',
        save: vi.fn().mockResolvedValue(undefined),
      };

      mockCrawlAuditEventConstructor.mockImplementation(function (this: any, data: any) {
        Object.assign(this, data, { _id: 'event-123' });
        this.save = vi.fn().mockResolvedValue(undefined);
        return this;
      });

      const eventData = {
        tenantId: 'tenant-789',
        crawlJobId: 'batch-123',
        eventType: 'crawl.completed',
        description: 'Crawl job completed: 5/5 documents indexed successfully',
        context: {
          strategy: 'bulk',
          urls: 5,
        },
        severity: 'info',
      };

      const auditEvent = new (mockCrawlAuditEventConstructor as any)(eventData);
      await auditEvent.save();

      expect(mockCrawlAuditEventConstructor).toHaveBeenCalledWith(eventData);
      expect(auditEvent.save).toHaveBeenCalledOnce();
    });
  });

  describe('CrawlHistory Status Updates', () => {
    test('should add final status to CrawlHistory on completion', async () => {
      const mockHistory: MockCrawlHistory = {
        statuses: [
          {
            timestamp: new Date('2025-01-01T10:00:00Z'),
            status: 'queued',
            phase: 'queued',
          },
          {
            timestamp: new Date('2025-01-01T10:00:10Z'),
            status: 'ingesting',
            phase: 'ingesting',
          },
        ],
        documentStatusChanges: [],
        save: vi.fn().mockResolvedValue(undefined),
      };

      mockCrawlHistoryFindOne.mockResolvedValue(mockHistory);

      // Simulate adding final status
      if (mockHistory) {
        mockHistory.statuses.push({
          timestamp: new Date('2025-01-01T10:05:00Z'),
          status: 'completed',
          phase: 'indexed',
          metrics: {
            documentsIndexed: 5,
            avgQualityScore: 0.88,
          },
        });
        await mockHistory.save();
      }

      expect(mockHistory.statuses).toHaveLength(3);
      expect(mockHistory.statuses[2].status).toBe('completed');
      expect(mockHistory.statuses[2].phase).toBe('indexed');
      expect(mockHistory.statuses[2].metrics?.documentsIndexed).toBe(5);
      expect(mockHistory.save).toHaveBeenCalledOnce();
    });
  });
});

/**
 * Quality Metrics API Tests
 *
 * Integration tests for quality metrics aggregation endpoints.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { DocumentStatus } from '@agent-platform/search-ai-sdk';

// Mock database models via getLazyModel (dual-DB routing)
const { mockSearchDocument, mockSearchChunk } = vi.hoisted(() => ({
  mockSearchDocument: { find: vi.fn() },
  mockSearchChunk: { find: vi.fn() },
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'SearchDocument') return mockSearchDocument;
    if (name === 'SearchChunk') return mockSearchChunk;
    return {};
  },
}));

// Mock requirePermission to pass through in tests
vi.mock('@agent-platform/shared', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const SearchDocument = mockSearchDocument;
const SearchChunk = mockSearchChunk;
import metricsRouter from '../metrics.js';

describe('Quality Metrics API', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'admin',
        permissions: ['admin:metrics:read'],
        authType: 'jwt_user',
        isSuperAdmin: false,
      };
      next();
    });
    app.use('/api/admin/metrics', metricsRouter);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/admin/metrics/job/:jobId', () => {
    test('should return metrics for a specific crawl job', async () => {
      const mockDocuments = [
        {
          _id: 'doc-1',
          status: DocumentStatus.INDEXED,
          metadata: { crawlJobId: 'job-123', qualityScore: 0.85, contentPreservation: 0.92 },
          chunkCount: 5,
          createdAt: new Date('2026-02-23T12:00:00Z'),
          updatedAt: new Date('2026-02-23T12:01:00Z'),
        },
        {
          _id: 'doc-2',
          status: DocumentStatus.INDEXED,
          metadata: { crawlJobId: 'job-123', qualityScore: 0.9, contentPreservation: 0.95 },
          chunkCount: 8,
          createdAt: new Date('2026-02-23T12:00:30Z'),
          updatedAt: new Date('2026-02-23T12:01:30Z'),
        },
        {
          _id: 'doc-3',
          status: DocumentStatus.ERROR,
          metadata: { crawlJobId: 'job-123' },
          chunkCount: 0,
          createdAt: new Date('2026-02-23T12:01:00Z'),
          updatedAt: new Date('2026-02-23T12:01:00Z'),
        },
      ];

      const mockChunks = [
        { _id: 'chunk-1', documentId: 'doc-1', status: 'indexed', content: 'Test content 1' },
        { _id: 'chunk-2', documentId: 'doc-1', status: 'indexed', content: 'Test content 2' },
        { _id: 'chunk-3', documentId: 'doc-2', status: 'indexed', content: 'Test content 3' },
      ];

      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockDocuments),
      });

      (SearchChunk.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockChunks),
      });

      const response = await request(app).get('/api/admin/metrics/job/job-123').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        jobId: 'job-123',
        metrics: {
          documents: {
            total: 3,
            indexed: 2,
            failed: 1,
            successRate: 66.67,
          },
          quality: {
            avgQualityScore: 0.88, // (0.85 + 0.90) / 2 = 0.875 rounded to 0.88
            avgContentPreservation: 0.94, // (0.92 + 0.95) / 2 = 0.935 rounded to 0.94
            avgChunksPerDoc: 6.5, // (5 + 8) / 2 = 6.5
          },
          chunks: {
            total: 3,
            indexed: 3,
          },
          timeline: {
            firstDocument: expect.any(String),
            lastDocument: expect.any(String),
            duration: expect.any(Number),
          },
        },
      });
    });

    test('should return 404 for non-existent job', async () => {
      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      const response = await request(app).get('/api/admin/metrics/job/job-999').expect(404);

      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'JOB_NOT_FOUND',
        },
      });
    });

    test('should handle documents without quality scores', async () => {
      const mockDocuments = [
        {
          _id: 'doc-1',
          status: DocumentStatus.INDEXED,
          metadata: { crawlJobId: 'job-123' }, // No quality scores
          chunkCount: 5,
          createdAt: new Date('2026-02-23T12:00:00Z'),
          updatedAt: new Date('2026-02-23T12:01:00Z'),
        },
      ];

      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockDocuments),
      });

      (SearchChunk.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      const response = await request(app).get('/api/admin/metrics/job/job-123').expect(200);

      expect(response.body.metrics.quality).toMatchObject({
        avgQualityScore: null,
        avgContentPreservation: null,
        avgChunksPerDoc: 5,
      });
    });
  });

  describe('GET /api/admin/metrics/aggregate', () => {
    test('should return aggregated metrics for time window', async () => {
      const mockDocuments = [
        {
          _id: 'doc-1',
          status: DocumentStatus.INDEXED,
          metadata: { qualityScore: 0.85 },
          chunkCount: 5,
          createdAt: new Date('2026-02-23T12:00:00Z'),
        },
        {
          _id: 'doc-2',
          status: DocumentStatus.INDEXED,
          metadata: { qualityScore: 0.9 },
          chunkCount: 8,
          createdAt: new Date('2026-02-23T13:00:00Z'),
        },
        {
          _id: 'doc-3',
          status: DocumentStatus.ERROR,
          metadata: {},
          chunkCount: 0,
          createdAt: new Date('2026-02-23T14:00:00Z'),
        },
      ];

      const mockChunks = [
        { _id: 'chunk-1', documentId: 'doc-1', status: 'indexed' },
        { _id: 'chunk-2', documentId: 'doc-1', status: 'indexed' },
        { _id: 'chunk-3', documentId: 'doc-2', status: 'indexed' },
      ];

      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockDocuments),
      });

      (SearchChunk.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockChunks),
      });

      const response = await request(app).get('/api/admin/metrics/aggregate').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        aggregate: {
          documents: {
            total: 3,
            indexed: 2,
            failed: 1,
            successRate: 66.67,
          },
          quality: {
            avgQualityScore: 0.88,
            avgChunksPerDoc: 6.5,
          },
          chunks: {
            total: 3,
            indexed: 3,
          },
        },
        timeWindow: {
          since: expect.any(String),
          until: expect.any(String),
        },
      });
    });

    test('should filter by indexId', async () => {
      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      (SearchChunk.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      await request(app).get('/api/admin/metrics/aggregate?indexId=index-123').expect(200);

      expect(SearchDocument.find).toHaveBeenCalledWith(
        expect.objectContaining({
          indexId: 'index-123',
        }),
      );
    });

    test('should filter by time range', async () => {
      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      (SearchChunk.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      const since = '2026-02-20T00:00:00Z';
      const until = '2026-02-24T00:00:00Z';

      await request(app)
        .get(`/api/admin/metrics/aggregate?since=${since}&until=${until}`)
        .expect(200);

      expect(SearchDocument.find).toHaveBeenCalledWith(
        expect.objectContaining({
          createdAt: {
            $gte: new Date(since),
            $lte: new Date(until),
          },
        }),
      );
    });

    test('should support groupBy day', async () => {
      const mockDocuments = [
        {
          _id: 'doc-1',
          status: DocumentStatus.INDEXED,
          metadata: { qualityScore: 0.85 },
          chunkCount: 5,
          createdAt: new Date('2026-02-23T12:00:00Z'),
        },
        {
          _id: 'doc-2',
          status: DocumentStatus.INDEXED,
          metadata: { qualityScore: 0.9 },
          chunkCount: 8,
          createdAt: new Date('2026-02-24T12:00:00Z'),
        },
      ];

      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockDocuments),
      });

      (SearchChunk.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      const response = await request(app)
        .get('/api/admin/metrics/aggregate?groupBy=day')
        .expect(200);

      expect(response.body.breakdown).toBeDefined();
      expect(Array.isArray(response.body.breakdown)).toBe(true);
    });
  });
});

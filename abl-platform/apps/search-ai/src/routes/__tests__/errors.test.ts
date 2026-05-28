/**
 * Error Tracking API Tests
 *
 * Integration tests for error tracking and aggregation endpoints.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { DocumentStatus } from '@agent-platform/search-ai-sdk';

// Mock database models via getLazyModel (dual-DB routing)
const { mockSearchDocument } = vi.hoisted(() => ({
  mockSearchDocument: {
    find: vi.fn(),
    findById: vi.fn(),
    findOne: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'SearchDocument') return mockSearchDocument;
    return {};
  },
}));

// Mock requirePermission to pass through in tests
vi.mock('@agent-platform/shared', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const SearchDocument = mockSearchDocument;
import errorsRouter from '../errors.js';

describe('Error Tracking API', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    // Inject tenant context for all requests
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'admin',
        permissions: ['admin:errors:read', 'admin:errors:retry'],
        authType: 'jwt_user',
        isSuperAdmin: false,
      };
      next();
    });
    app.use('/api/admin/errors', errorsRouter);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/admin/errors', () => {
    test('should return error documents with pagination', async () => {
      const mockErrors = [
        {
          _id: 'doc-1',
          indexId: 'index-123',
          tenantId: 'tenant-456',
          status: DocumentStatus.ERROR,
          processingError: 'Failed to extract content: timeout',
          updatedAt: new Date('2026-02-23T12:00:00Z'),
          metadata: { source: 'test.pdf' },
        },
        {
          _id: 'doc-2',
          indexId: 'index-123',
          tenantId: 'tenant-456',
          status: DocumentStatus.ERROR,
          processingError: 'Network error: connection refused',
          updatedAt: new Date('2026-02-23T11:00:00Z'),
          metadata: { source: 'test2.pdf' },
        },
      ];

      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockErrors),
      });

      (SearchDocument.countDocuments as any).mockResolvedValue(2);

      const response = await request(app).get('/api/admin/errors').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        total: 2,
        limit: 100,
        offset: 0,
      });

      expect(response.body.errors).toHaveLength(2);
      expect(response.body.errors[0]).toMatchObject({
        documentId: 'doc-1',
        indexId: 'index-123',
        status: DocumentStatus.ERROR,
        error: 'Failed to extract content: timeout',
      });
    });

    test('should filter by indexId', async () => {
      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      (SearchDocument.countDocuments as any).mockResolvedValue(0);

      await request(app).get('/api/admin/errors?indexId=index-123').expect(200);

      expect(SearchDocument.find).toHaveBeenCalledWith(
        expect.objectContaining({
          indexId: 'index-123',
        }),
      );
    });

    test('should filter by time range', async () => {
      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      (SearchDocument.countDocuments as any).mockResolvedValue(0);

      const since = '2026-02-23T00:00:00Z';
      const until = '2026-02-24T00:00:00Z';

      await request(app).get(`/api/admin/errors?since=${since}&until=${until}`).expect(200);

      expect(SearchDocument.find).toHaveBeenCalledWith(
        expect.objectContaining({
          updatedAt: {
            $gte: new Date(since),
            $lte: new Date(until),
          },
        }),
      );
    });

    test('should respect pagination limits', async () => {
      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      (SearchDocument.countDocuments as any).mockResolvedValue(0);

      const response = await request(app).get('/api/admin/errors?limit=50&offset=100').expect(200);

      expect(response.body.limit).toBe(50);
      expect(response.body.offset).toBe(100);
    });

    test('should cap limit at 1000', async () => {
      (SearchDocument.find as any).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      (SearchDocument.countDocuments as any).mockResolvedValue(0);

      const response = await request(app).get('/api/admin/errors?limit=5000').expect(200);

      expect(response.body.limit).toBe(1000);
    });
  });

  describe('GET /api/admin/errors/stats', () => {
    test('should return aggregated error statistics', async () => {
      const mockErrors = [
        {
          indexId: 'index-1',
          processingError: 'Timeout error',
          updatedAt: new Date('2026-02-23T12:00:00Z'),
        },
        {
          indexId: 'index-1',
          processingError: 'Timeout error',
          updatedAt: new Date('2026-02-23T11:00:00Z'),
        },
        {
          indexId: 'index-2',
          processingError: 'Network error',
          updatedAt: new Date('2026-02-23T10:00:00Z'),
        },
      ];

      const mockRecentErrors = [
        {
          _id: 'doc-1',
          indexId: 'index-1',
          processingError: 'Timeout error',
          updatedAt: new Date('2026-02-23T12:00:00Z'),
        },
      ];

      // Mock for aggregation (first call - .find().select().lean())
      const mockFindFirst = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockErrors),
      });

      // Mock for recent errors (second call - full query chain)
      const mockFindSecond = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockRecentErrors),
      });

      // Set up sequential mocks
      (SearchDocument.find as any)
        .mockImplementationOnce(mockFindFirst)
        .mockImplementationOnce(mockFindSecond);

      const response = await request(app).get('/api/admin/errors/stats').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        stats: {
          total: 3,
          byIndex: {
            'index-1': 2,
            'index-2': 1,
          },
          byErrorType: {
            'Timeout error': 2,
            'Network error': 1,
          },
        },
      });

      expect(response.body.stats.recentErrors).toHaveLength(1);
      expect(response.body.timeWindow).toBeDefined();
    });
  });

  describe('POST /api/admin/errors/:documentId/retry', () => {
    test('should retry a failed document', async () => {
      const mockDocument = {
        _id: 'doc-123',
        status: DocumentStatus.ERROR,
        processingError: 'Failed to process',
        save: vi.fn().mockResolvedValue(undefined),
      };

      (SearchDocument.findOne as any).mockResolvedValue(mockDocument);

      const response = await request(app).post('/api/admin/errors/doc-123/retry').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        documentId: 'doc-123',
        previousStatus: DocumentStatus.ERROR,
        newStatus: DocumentStatus.PENDING,
      });

      expect(mockDocument.status).toBe(DocumentStatus.PENDING);
      expect(mockDocument.processingError).toBeNull();
      expect(mockDocument.save).toHaveBeenCalled();
    });

    test('should return 404 for non-existent document', async () => {
      (SearchDocument.findOne as any).mockResolvedValue(null);

      const response = await request(app).post('/api/admin/errors/doc-999/retry').expect(404);

      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'DOCUMENT_NOT_FOUND',
        },
      });
    });

    test('should return 400 if document is not in ERROR status', async () => {
      const mockDocument = {
        _id: 'doc-123',
        status: DocumentStatus.INDEXED,
      };

      (SearchDocument.findOne as any).mockResolvedValue(mockDocument);

      const response = await request(app).post('/api/admin/errors/doc-123/retry').expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'DOCUMENT_NOT_FAILED',
        },
      });
    });
  });
});

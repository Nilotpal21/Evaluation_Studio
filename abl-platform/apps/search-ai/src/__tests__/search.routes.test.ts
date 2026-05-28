/**
 * Search Routes Tests
 *
 * Tests the example search routes with permission filtering:
 * - POST /search - Semantic search with permission filtering
 * - POST /search/hybrid - Hybrid search with permission filtering
 * - GET /search/debug - Debug endpoint for inspecting permissions
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type { PermissionFilteredRequest } from '../middleware/permission-filter.middleware.js';

// =============================================================================
// Mocks
// =============================================================================

const mockApplyPermissionFilter = vi.fn();
const mockHasPermissionFilter = vi.fn();
const mockGetAccessibleDocumentIds = vi.fn();

vi.mock('../middleware/permission-filter.middleware.js', () => ({
  applyPermissionFilter: () => mockApplyPermissionFilter,
  hasPermissionFilter: mockHasPermissionFilter,
  getAccessibleDocumentIds: mockGetAccessibleDocumentIds,
}));

// =============================================================================
// Test Data
// =============================================================================

const mockDocumentIds = ['doc-1', 'doc-2', 'doc-3', 'doc-4', 'doc-5'];

const mockPermissionMetadata = {
  totalAccessible: 5,
  cacheHit: false,
  queryDurationMs: 10,
  isComplete: true,
};

function createMockRequest(overrides?: Partial<Request>): Request {
  return {
    body: {},
    params: {},
    query: {},
    tenantContext: {
      tenantId: 'tenant-123',
      userId: 'john@example.com', // For user auth, userId IS the email
      userEmail: undefined as any, // This field doesn't exist in TenantContextData
    } as any,
    ...overrides,
  } as Request;
}

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

// =============================================================================
// Tests
// =============================================================================

describe('Search Routes', () => {
  // Load the router dynamically to ensure mocks are applied
  let searchRouter: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default mock implementations
    mockGetAccessibleDocumentIds.mockReturnValue(mockDocumentIds);
    mockHasPermissionFilter.mockReturnValue(true);

    // Import the router
    searchRouter = (await import('../routes/search.js')).default;
  });

  // ─── POST /search ──────────────────────────────────────────────────────

  describe('POST /search', () => {
    test('validates required fields', async () => {
      const req = createMockRequest({
        body: {
          // Missing query and indexId
        },
      });
      const res = createMockResponse();

      // Find the handler for POST /search
      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search' && layer.route.methods.post,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'query and indexId are required',
      });
    });

    test('rejects request without permission filtering', async () => {
      mockGetAccessibleDocumentIds.mockReturnValueOnce(null);

      const req = createMockRequest({
        body: {
          query: 'financial reports Q4',
          indexId: 'index-123',
        },
      });
      const res = createMockResponse();

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search' && layer.route.methods.post,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Permission filtering not applied',
      });
    });

    test('performs search with accessible document IDs', async () => {
      const req = createMockRequest({
        body: {
          query: 'financial reports Q4',
          indexId: 'index-123',
          topK: 10,
          similarityThreshold: 0.7,
        },
      }) as PermissionFilteredRequest;

      req.permissionFilterMetadata = mockPermissionMetadata;

      const res = createMockResponse();

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search' && layer.route.methods.post,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(mockGetAccessibleDocumentIds).toHaveBeenCalledWith(req);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          results: expect.any(Array),
          total: expect.any(Number),
          permissionMetadata: mockPermissionMetadata,
        }),
      );
    });

    test('uses default values for optional parameters', async () => {
      const req = createMockRequest({
        body: {
          query: 'test query',
          indexId: 'index-123',
          // topK and similarityThreshold not provided
        },
      }) as PermissionFilteredRequest;

      req.permissionFilterMetadata = mockPermissionMetadata;

      const res = createMockResponse();

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search' && layer.route.methods.post,
      )?.route?.stack[1].handle;

      await handler(req, res);

      // Verify defaults are applied (topK=10, similarityThreshold=0.7)
      expect(res.json).toHaveBeenCalled();
    });

    test('handles search errors gracefully', async () => {
      const req = createMockRequest({
        body: {
          query: 'test query',
          indexId: 'index-123',
        },
      });
      const res = createMockResponse();

      // Mock getAccessibleDocumentIds to throw error
      mockGetAccessibleDocumentIds.mockImplementationOnce(() => {
        throw new Error('Mock error');
      });

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search' && layer.route.methods.post,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Search failed',
      });
    });
  });

  // ─── POST /search/hybrid ───────────────────────────────────────────────

  describe('POST /search/hybrid', () => {
    test('validates required fields', async () => {
      const req = createMockRequest({
        body: {
          // Missing query and indexId
        },
      });
      const res = createMockResponse();

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search/hybrid' && layer.route.methods.post,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'query and indexId are required',
      });
    });

    test('rejects request without permission filtering', async () => {
      mockGetAccessibleDocumentIds.mockReturnValueOnce(null);

      const req = createMockRequest({
        body: {
          query: 'financial reports Q4',
          indexId: 'index-123',
        },
      });
      const res = createMockResponse();

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search/hybrid' && layer.route.methods.post,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Permission filtering not applied',
      });
    });

    test('performs hybrid search with accessible document IDs', async () => {
      const req = createMockRequest({
        body: {
          query: 'financial reports Q4',
          indexId: 'index-123',
          topK: 10,
          hybridWeights: { keyword: 0.3, semantic: 0.7 },
        },
      }) as PermissionFilteredRequest;

      req.permissionFilterMetadata = mockPermissionMetadata;

      const res = createMockResponse();

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search/hybrid' && layer.route.methods.post,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(mockGetAccessibleDocumentIds).toHaveBeenCalledWith(req);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          results: expect.any(Array),
          total: expect.any(Number),
          searchMethod: 'hybrid',
          weights: { keyword: 0.3, semantic: 0.7 },
          permissionMetadata: mockPermissionMetadata,
        }),
      );
    });

    test('uses default hybrid weights', async () => {
      const req = createMockRequest({
        body: {
          query: 'test query',
          indexId: 'index-123',
          topK: 10,
          // hybridWeights not provided
        },
      }) as PermissionFilteredRequest;

      req.permissionFilterMetadata = mockPermissionMetadata;

      const res = createMockResponse();

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search/hybrid' && layer.route.methods.post,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          weights: { keyword: 0.3, semantic: 0.7 },
        }),
      );
    });

    test('handles hybrid search errors gracefully', async () => {
      const req = createMockRequest({
        body: {
          query: 'test query',
          indexId: 'index-123',
        },
      });
      const res = createMockResponse();

      // Mock getAccessibleDocumentIds to throw error
      mockGetAccessibleDocumentIds.mockImplementationOnce(() => {
        throw new Error('Mock error');
      });

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search/hybrid' && layer.route.methods.post,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Hybrid search failed',
      });
    });
  });

  // ─── GET /search/debug ─────────────────────────────────────────────────

  describe('GET /search/debug', () => {
    test('rejects request without permission filtering', async () => {
      mockHasPermissionFilter.mockReturnValueOnce(false);

      const req = createMockRequest();
      const res = createMockResponse();

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search/debug' && layer.route.methods.get,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Permission filtering not applied',
      });
    });

    test('returns accessible document info', async () => {
      const req = createMockRequest() as PermissionFilteredRequest;
      req.accessibleDocumentIds = mockDocumentIds;
      req.permissionFilterMetadata = mockPermissionMetadata;

      const res = createMockResponse();

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search/debug' && layer.route.methods.get,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        accessibleDocuments: {
          count: 5,
          sampleIds: mockDocumentIds.slice(0, 10),
        },
        metadata: mockPermissionMetadata,
        user: {
          tenantId: 'tenant-123',
          userId: 'john@example.com',
          email: 'john@example.com', // For user auth, userId IS the email
        },
      });
    });

    test('handles large document sets (returns sample)', async () => {
      const largeDocumentSet = Array.from({ length: 100 }, (_, i) => `doc-${i}`);

      const req = createMockRequest() as PermissionFilteredRequest;
      req.accessibleDocumentIds = largeDocumentSet;
      req.permissionFilterMetadata = mockPermissionMetadata;

      const res = createMockResponse();

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search/debug' && layer.route.methods.get,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          accessibleDocuments: {
            count: 100,
            sampleIds: largeDocumentSet.slice(0, 10), // Only first 10
          },
        }),
      );
    });

    test('handles empty accessible documents', async () => {
      const req = createMockRequest() as PermissionFilteredRequest;
      req.accessibleDocumentIds = [];
      req.permissionFilterMetadata = mockPermissionMetadata;

      const res = createMockResponse();

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search/debug' && layer.route.methods.get,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          accessibleDocuments: {
            count: 0,
            sampleIds: [],
          },
        }),
      );
    });

    test('handles debug endpoint errors gracefully', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Mock hasPermissionFilter to throw error
      mockHasPermissionFilter.mockImplementationOnce(() => {
        throw new Error('Mock error');
      });

      const handler = searchRouter.stack.find(
        (layer: any) => layer.route?.path === '/search/debug' && layer.route.methods.get,
      )?.route?.stack[1].handle;

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Debug endpoint failed',
      });
    });
  });
});

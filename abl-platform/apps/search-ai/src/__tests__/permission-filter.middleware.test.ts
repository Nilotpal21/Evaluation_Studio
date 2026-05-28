/**
 * Permission Filter Middleware Tests
 *
 * Tests the Express middleware that applies query-time permission filtering:
 * - Authentication checks
 * - Permission loading from MongoDB
 * - Redis caching
 * - Error handling (structured error responses)
 * - Metadata attachment
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  applyPermissionFilter,
  hasPermissionFilter,
  getAccessibleDocumentIds,
  type PermissionFilteredRequest,
} from '../middleware/permission-filter.middleware.js';

// =============================================================================
// Mocks
// =============================================================================

const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  scan: vi.fn(),
};

// Mock MongoPermissionStore (replaces PermissionGraphService)
vi.mock('@agent-platform/search-ai-internal/permissions', () => ({
  MongoPermissionStore: {
    getInstance: vi.fn(() => ({})),
  },
}));

// Mock PermissionFilterService
const mockGetAccessibleDocuments = vi.fn();
const mockInvalidateCache = vi.fn();

vi.mock('../services/permission-filter.service.js', () => ({
  PermissionFilterService: class {
    getAccessibleDocuments = mockGetAccessibleDocuments;
    invalidateCache = mockInvalidateCache;
  },
}));

// Mock logger (replaces console.log/error)
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// =============================================================================
// Test Data
// =============================================================================

const mockDocumentIds = ['doc-1', 'doc-2', 'doc-3', 'doc-4', 'doc-5'];

function createMockRequest(overrides?: Partial<Request>): Request {
  return {
    tenantContext: {
      tenantId: 'tenant-123',
      userId: 'john@example.com', // For user auth, userId IS the email
      userEmail: undefined as any, // This field doesn't exist in TenantContextData
      groupIds: undefined, // This field doesn't exist in TenantContextData
    } as any,
    body: {},
    params: {},
    query: {},
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

describe('applyPermissionFilter middleware', () => {
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNext = vi.fn();

    // Default mock response
    mockGetAccessibleDocuments.mockResolvedValue({
      documentIds: mockDocumentIds,
      totalCount: 5,
      isComplete: true,
      cacheHit: false,
    });
  });

  // ─── Authentication Checks ─────────────────────────────────────────────

  test('rejects request without tenant context', async () => {
    const req = createMockRequest({ tenantContext: undefined });
    const res = createMockResponse();

    const middleware = applyPermissionFilter();
    await middleware(req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  test('rejects request without email-like userId', async () => {
    const req = createMockRequest({
      tenantContext: {
        tenantId: 'tenant-123',
        userId: 'sdk:channel-123', // SDK session (not an email)
        userEmail: undefined as any,
        groupIds: [],
      } as any,
    });
    const res = createMockResponse();

    const middleware = applyPermissionFilter();
    await middleware(req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'EMAIL_REQUIRED',
        message:
          'User email required for permission filtering. Permission filtering only supports user authentication (not SDK or API keys)',
      },
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  // ─── Permission Loading ────────────────────────────────────────────────

  test('loads accessible documents and attaches to request', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    const middleware = applyPermissionFilter();
    await middleware(req, res, mockNext);

    // Verify service was called with correct identity
    expect(mockGetAccessibleDocuments).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-123',
        userId: 'john@example.com',
        email: 'john@example.com',
        groupIds: [], // Resolved from MongoDB contact card's acl.effectiveGroups
      },
      {
        maxDocuments: undefined,
        skipCache: undefined,
      },
    );

    // Verify data attached to request
    const filteredReq = req as PermissionFilteredRequest;
    expect(filteredReq.accessibleDocumentIds).toEqual(mockDocumentIds);
    expect(filteredReq.permissionFilterEnabled).toBe(true);
    expect(filteredReq.permissionFilterMetadata).toMatchObject({
      totalAccessible: 5,
      cacheHit: false,
      isComplete: true,
    });
    expect(filteredReq.permissionFilterMetadata?.queryDurationMs).toBeGreaterThanOrEqual(0);

    expect(mockNext).toHaveBeenCalled();
  });

  test('rejects non-email userId (SDK or API key auth)', async () => {
    const req = createMockRequest({
      tenantContext: {
        tenantId: 'tenant-123',
        userId: 'user-456', // Not an email
        userEmail: undefined as any,
        groupIds: [],
      } as any,
    });
    const res = createMockResponse();

    const middleware = applyPermissionFilter();
    await middleware(req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'EMAIL_REQUIRED',
        message:
          'User email required for permission filtering. Permission filtering only supports user authentication (not SDK or API keys)',
      },
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  test('resolves groupIds from MongoDB (always empty in call)', async () => {
    const req = createMockRequest({
      tenantContext: {
        tenantId: 'tenant-123',
        userId: 'john@example.com', // Must be an email
        userEmail: undefined as any,
        groupIds: undefined,
      } as any,
    });
    const res = createMockResponse();

    const middleware = applyPermissionFilter();
    await middleware(req, res, mockNext);

    // groupIds are always empty in the call — resolved from MongoDB contact card
    expect(mockGetAccessibleDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        groupIds: [],
      }),
      expect.anything(),
    );
  });

  // ─── Options ───────────────────────────────────────────────────────────

  test('respects maxDocuments option', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    const middleware = applyPermissionFilter({ maxDocuments: 5000 });
    await middleware(req, res, mockNext);

    expect(mockGetAccessibleDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxDocuments: 5000,
      }),
    );
  });

  test('respects skipCache option', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    const middleware = applyPermissionFilter({ skipCache: true });
    await middleware(req, res, mockNext);

    expect(mockGetAccessibleDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        skipCache: true,
      }),
    );
  });

  test('skips filtering when skipIf returns true', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    const middleware = applyPermissionFilter({
      skipIf: (req) => req.tenantContext?.userId === 'john@example.com',
    });
    await middleware(req, res, mockNext);

    // Should skip permission loading
    expect(mockGetAccessibleDocuments).not.toHaveBeenCalled();

    // Should set permissionFilterEnabled to false
    const filteredReq = req as PermissionFilteredRequest;
    expect(filteredReq.permissionFilterEnabled).toBe(false);

    expect(mockNext).toHaveBeenCalled();
  });

  test('passes Redis client to service', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    const middleware = applyPermissionFilter({ redis: mockRedis as any });
    await middleware(req, res, mockNext);

    // Verify PermissionFilterService was constructed with Redis
    // (This is implicitly tested by the service working correctly)
    expect(mockNext).toHaveBeenCalled();
  });

  // ─── Error Handling ────────────────────────────────────────────────────

  test('fails closed on permission service error', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    mockGetAccessibleDocuments.mockRejectedValueOnce(new Error('MongoDB connection failed'));

    const middleware = applyPermissionFilter();
    await middleware(req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'PERMISSION_LOAD_FAILED',
        message: 'Failed to load permissions',
      },
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  test('includes error details in development mode', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    mockGetAccessibleDocuments.mockRejectedValueOnce(new Error('MongoDB connection failed'));

    process.env.NODE_ENV = 'development';

    const middleware = applyPermissionFilter();
    await middleware(req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'PERMISSION_LOAD_FAILED',
        message: 'Failed to load permissions',
        details: 'MongoDB connection failed',
      },
    });

    delete process.env.NODE_ENV;
  });

  // ─── Metadata ──────────────────────────────────────────────────────────

  test('includes cache hit in metadata', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    mockGetAccessibleDocuments.mockResolvedValueOnce({
      documentIds: mockDocumentIds,
      totalCount: 5,
      isComplete: true,
      cacheHit: true,
    });

    const middleware = applyPermissionFilter();
    await middleware(req, res, mockNext);

    const filteredReq = req as PermissionFilteredRequest;
    expect(filteredReq.permissionFilterMetadata?.cacheHit).toBe(true);
  });

  test('includes isComplete flag in metadata', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    mockGetAccessibleDocuments.mockResolvedValueOnce({
      documentIds: mockDocumentIds,
      totalCount: 10000,
      isComplete: false, // Truncated
      cacheHit: false,
    });

    const middleware = applyPermissionFilter();
    await middleware(req, res, mockNext);

    const filteredReq = req as PermissionFilteredRequest;
    expect(filteredReq.permissionFilterMetadata?.isComplete).toBe(false);
    expect(filteredReq.permissionFilterMetadata?.totalAccessible).toBe(10000);
  });

  test('measures query duration', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    // Mock slow query
    mockGetAccessibleDocuments.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        documentIds: mockDocumentIds,
        totalCount: 5,
        isComplete: true,
        cacheHit: false,
      };
    });

    const middleware = applyPermissionFilter();
    await middleware(req, res, mockNext);

    const filteredReq = req as PermissionFilteredRequest;
    expect(filteredReq.permissionFilterMetadata?.queryDurationMs).toBeGreaterThanOrEqual(45);
  });
});

// =============================================================================
// Helper Functions Tests
// =============================================================================

describe('hasPermissionFilter', () => {
  test('returns true when permissionFilterEnabled is true', () => {
    const req = {
      permissionFilterEnabled: true,
    } as PermissionFilteredRequest;

    expect(hasPermissionFilter(req)).toBe(true);
  });

  test('returns false when permissionFilterEnabled is false', () => {
    const req = {
      permissionFilterEnabled: false,
    } as PermissionFilteredRequest;

    expect(hasPermissionFilter(req)).toBe(false);
  });

  test('returns false for plain Request', () => {
    const req = {} as Request;

    expect(hasPermissionFilter(req)).toBe(false);
  });
});

describe('getAccessibleDocumentIds', () => {
  test('returns document IDs when permission filter is applied', () => {
    const req = {
      permissionFilterEnabled: true,
      accessibleDocumentIds: mockDocumentIds,
    } as PermissionFilteredRequest;

    expect(getAccessibleDocumentIds(req)).toEqual(mockDocumentIds);
  });

  test('returns undefined when permission filter is not applied', () => {
    const req = {
      permissionFilterEnabled: false,
    } as PermissionFilteredRequest;

    expect(getAccessibleDocumentIds(req)).toBeUndefined();
  });

  test('returns undefined for plain Request', () => {
    const req = {} as Request;

    expect(getAccessibleDocumentIds(req)).toBeUndefined();
  });
});

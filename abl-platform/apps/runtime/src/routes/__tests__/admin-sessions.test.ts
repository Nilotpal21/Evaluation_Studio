/**
 * Admin Sessions Dashboard API Tests
 *
 * Tests for session monitoring and management endpoints.
 * Verifies auth, admin permission enforcement, and tenant isolation.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// Mock auth middleware to pass through and inject tenantContext
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    // tenantContext is injected per-test via a middleware added before the router
    next();
  },
}));

// Mock @agent-platform/shared requirePermission to use real permission checking
vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
    // Use the real requirePermission so we can test permission enforcement
  };
});

// Mock session repository
vi.mock('../../repos/session-repo.js', () => ({
  listSessions: vi.fn(),
  countSessions: vi.fn(),
  findSessionById: vi.fn(),
}));

import { listSessions, countSessions, findSessionById } from '../../repos/session-repo.js';
import adminSessionsRouter from '../admin-sessions.js';

/** Tenant context with admin permissions (OWNER/ADMIN) */
const ADMIN_TENANT_ID = 'tenant-789';
const ADMIN_CONTEXT = {
  tenantId: ADMIN_TENANT_ID,
  userId: 'admin-user',
  permissions: ['*:*'],
  authType: 'jwt' as const,
  role: 'OWNER',
};

/** Tenant context with limited permissions (VIEWER) */
const VIEWER_CONTEXT = {
  tenantId: ADMIN_TENANT_ID,
  userId: 'viewer-user',
  permissions: ['tenant:read', 'project:read'],
  authType: 'jwt' as const,
  role: 'VIEWER',
};

function createApp(tenantContext?: Record<string, unknown>): Express {
  const app = express();
  app.use(express.json());
  if (tenantContext) {
    app.use((req: any, _res, next) => {
      req.tenantContext = tenantContext;
      next();
    });
  }
  app.use('/api/admin/runtime/sessions', adminSessionsRouter);
  return app;
}

describe('Admin Sessions Dashboard API', () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(ADMIN_CONTEXT);
    vi.clearAllMocks();
  });

  describe('GET /api/admin/runtime/sessions', () => {
    test('should return paginated session list with default parameters', async () => {
      const mockSessions = [
        {
          id: 'session-123',
          tenantId: 'tenant-789',
          projectId: 'project-456',
          currentAgent: 'customer-support',
          agentVersion: 'v1.2.0',
          channel: 'web',
          status: 'active',
          disposition: null,
          startedAt: new Date('2026-02-24T10:00:00Z'),
          lastActivityAt: new Date('2026-02-24T10:05:00Z'),
          endedAt: null,
          messageCount: 12,
          tokenCount: 1500,
          estimatedCost: 0.003,
          errorCount: 0,
          handoffCount: 1,
          traceEventCount: 45,
          identityTier: 2,
          verificationMethod: 'email',
          customerId: 'customer-001',
          anonymousId: null,
          isTest: false,
        },
      ];

      vi.mocked(listSessions).mockResolvedValue(mockSessions);
      vi.mocked(countSessions).mockResolvedValue(1);

      const response = await request(app).get('/api/admin/runtime/sessions');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.sessions).toHaveLength(1);
      expect(response.body.sessions[0].id).toBe('session-123');
      expect(response.body.sessions[0].durationMs).toBeGreaterThan(0);
      expect(response.body.sessions[0].durationFormatted).toBeDefined();
      expect(response.body.pagination).toEqual({
        total: 1,
        limit: 50,
        offset: 0,
        hasMore: false,
      });
    });

    test('should filter sessions by agent', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);
      vi.mocked(countSessions).mockResolvedValue(0);

      const response = await request(app).get('/api/admin/runtime/sessions?agentId=booking-agent');

      expect(response.status).toBe(200);
      expect(vi.mocked(listSessions)).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-789',
          currentAgent: 'booking-agent',
        }),
        expect.any(Object),
      );
    });

    test('should filter sessions by status', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);
      vi.mocked(countSessions).mockResolvedValue(0);

      const response = await request(app).get('/api/admin/runtime/sessions?status=completed');

      expect(response.status).toBe(200);
      expect(vi.mocked(listSessions)).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-789',
          status: 'completed',
        }),
        expect.any(Object),
      );
    });

    test('should filter sessions by channel', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);
      vi.mocked(countSessions).mockResolvedValue(0);

      const response = await request(app).get('/api/admin/runtime/sessions?channel=slack');

      expect(response.status).toBe(200);
      expect(vi.mocked(listSessions)).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-789',
          channel: 'slack',
        }),
        expect.any(Object),
      );
    });

    test('should filter sessions by identity tier', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);
      vi.mocked(countSessions).mockResolvedValue(0);

      const response = await request(app).get('/api/admin/runtime/sessions?identityTier=2');

      expect(response.status).toBe(200);
      expect(vi.mocked(listSessions)).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-789',
          identityTier: 2,
        }),
        expect.any(Object),
      );
    });

    test('should filter sessions by date range', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);
      vi.mocked(countSessions).mockResolvedValue(0);

      const since = '2026-02-01T00:00:00Z';
      const until = '2026-02-28T23:59:59Z';

      const response = await request(app).get(
        `/api/admin/runtime/sessions?since=${since}&until=${until}`,
      );

      expect(response.status).toBe(200);
      expect(vi.mocked(listSessions)).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-789',
          startedAt: expect.objectContaining({
            $gte: expect.any(Date),
            $lte: expect.any(Date),
          }),
        }),
        expect.any(Object),
      );
    });

    test('should apply pagination with custom limit and offset', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);
      vi.mocked(countSessions).mockResolvedValue(150);

      const response = await request(app).get('/api/admin/runtime/sessions?limit=25&offset=50');

      expect(response.status).toBe(200);
      expect(response.body.pagination).toEqual({
        total: 150,
        limit: 25,
        offset: 50,
        hasMore: true,
      });
    });

    test('should enforce maximum limit of 100', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);
      vi.mocked(countSessions).mockResolvedValue(0);

      const response = await request(app).get('/api/admin/runtime/sessions?limit=500');

      expect(response.status).toBe(200);
      expect(response.body.pagination.limit).toBe(100);
    });

    test('should handle database errors gracefully', async () => {
      vi.mocked(listSessions).mockRejectedValue(new Error('Database connection failed'));

      const response = await request(app).get('/api/admin/runtime/sessions');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal server error');
    });
  });

  describe('GET /api/admin/runtime/sessions/:sessionId', () => {
    test('should return full session details', async () => {
      const mockSession = {
        id: 'session-123',
        tenantId: 'tenant-789',
        projectId: 'project-456',
        currentAgent: 'customer-support',
        agentVersion: 'v1.2.0',
        environment: 'production',
        channel: 'web',
        channelHistory: ['web'],
        status: 'completed',
        disposition: 'resolved',
        dispositionCode: 'issue_resolved',
        startedAt: new Date('2026-02-24T10:00:00Z'),
        lastActivityAt: new Date('2026-02-24T10:15:00Z'),
        endedAt: new Date('2026-02-24T10:15:00Z'),
        messageCount: 18,
        tokenCount: 2500,
        estimatedCost: 0.005,
        errorCount: 0,
        handoffCount: 1,
        traceEventCount: 67,
        identityTier: 2,
        verificationMethod: 'email',
        customerId: 'customer-001',
        anonymousId: null,
        isTest: false,
      };

      vi.mocked(findSessionById).mockResolvedValue(mockSession);

      const response = await request(app).get('/api/admin/runtime/sessions/session-123');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.session.id).toBe('session-123');
      expect(response.body.session.durationMs).toBeGreaterThan(0);
      expect(response.body.session.durationFormatted).toBeDefined();
    });

    test('should return 404 if session not found', async () => {
      vi.mocked(findSessionById).mockResolvedValue(null);

      const response = await request(app).get('/api/admin/runtime/sessions/session-999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Session not found');
    });

    test('should handle database errors gracefully', async () => {
      vi.mocked(findSessionById).mockRejectedValue(new Error('Database error'));

      const response = await request(app).get('/api/admin/runtime/sessions/session-123');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal server error');
    });
  });

  describe('GET /api/admin/runtime/sessions/stats', () => {
    test('should return aggregate session statistics', async () => {
      const mockSessions = [
        {
          status: 'completed',
          channel: 'web',
          messageCount: 10,
          tokenCount: 1000,
          estimatedCost: 0.002,
          errorCount: 0,
          handoffCount: 1,
          traceEventCount: 30,
          startedAt: new Date('2026-02-24T10:00:00Z'),
          lastActivityAt: new Date('2026-02-24T10:10:00Z'),
          endedAt: new Date('2026-02-24T10:10:00Z'),
        },
        {
          status: 'completed',
          channel: 'slack',
          messageCount: 15,
          tokenCount: 1500,
          estimatedCost: 0.003,
          errorCount: 1,
          handoffCount: 0,
          traceEventCount: 45,
          startedAt: new Date('2026-02-24T11:00:00Z'),
          lastActivityAt: new Date('2026-02-24T11:12:00Z'),
          endedAt: new Date('2026-02-24T11:12:00Z'),
        },
        {
          status: 'active',
          channel: 'web',
          messageCount: 5,
          tokenCount: 500,
          estimatedCost: 0.001,
          errorCount: 0,
          handoffCount: 0,
          traceEventCount: 15,
          startedAt: new Date('2026-02-24T12:00:00Z'),
          lastActivityAt: new Date('2026-02-24T12:03:00Z'),
          endedAt: null,
        },
      ];

      vi.mocked(listSessions).mockResolvedValue(mockSessions);

      const response = await request(app).get('/api/admin/runtime/sessions/stats');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.stats.totalSessions).toBe(3);
      expect(response.body.stats.byStatus).toEqual({
        completed: 2,
        active: 1,
      });
      expect(response.body.stats.byChannel).toEqual({
        web: 2,
        slack: 1,
      });
      expect(response.body.stats.metrics.totalMessages).toBe(30);
      expect(response.body.stats.metrics.totalTokens).toBe(3000);
      expect(response.body.stats.metrics.totalEstimatedCost).toBe(0.006);
      expect(response.body.stats.metrics.totalErrors).toBe(1);
      expect(response.body.stats.metrics.totalHandoffs).toBe(1);
      expect(response.body.stats.metrics.totalTraceEvents).toBe(90);
      expect(response.body.stats.metrics.avgSessionDuration).toBeGreaterThan(0);
      expect(response.body.stats.metrics.avgSessionDurationFormatted).toBeDefined();
    });

    test('should filter stats by agent', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);

      const response = await request(app).get(
        '/api/admin/runtime/sessions/stats?agentId=booking-agent',
      );

      expect(response.status).toBe(200);
      expect(vi.mocked(listSessions)).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-789',
          currentAgent: 'booking-agent',
        }),
        expect.any(Object),
      );
    });

    test('should handle empty result set', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);

      const response = await request(app).get('/api/admin/runtime/sessions/stats');

      expect(response.status).toBe(200);
      expect(response.body.stats.totalSessions).toBe(0);
      expect(response.body.stats.metrics.avgSessionDuration).toBe(0);
    });

    test('should handle database errors gracefully', async () => {
      vi.mocked(listSessions).mockRejectedValue(new Error('Database error'));

      const response = await request(app).get('/api/admin/runtime/sessions/stats');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal server error');
    });
  });

  describe('Duration formatting', () => {
    test('should format durations correctly', async () => {
      const mockSession = {
        id: 'session-123',
        tenantId: 'tenant-789',
        startedAt: new Date('2026-02-24T10:00:00Z'),
        lastActivityAt: new Date('2026-02-24T10:00:05.500Z'), // 5.5 seconds
        endedAt: null,
        messageCount: 1,
        tokenCount: 100,
        estimatedCost: 0.0001,
        errorCount: 0,
        handoffCount: 0,
        traceEventCount: 3,
      };

      vi.mocked(findSessionById).mockResolvedValue(mockSession);

      const response = await request(app).get('/api/admin/runtime/sessions/session-123');

      expect(response.status).toBe(200);
      expect(response.body.session.durationFormatted).toMatch(/s$/); // Should end with 's' for seconds
    });
  });

  // ---------------------------------------------------------------------------
  // Authorization enforcement
  // ---------------------------------------------------------------------------
  describe('Authorization', () => {
    test('should return 401 for unauthenticated requests (no tenantContext)', async () => {
      const unauthApp = createApp(); // no tenantContext injected
      const response = await request(unauthApp).get('/api/admin/runtime/sessions');
      expect(response.status).toBe(401);
      expect(response.body.error).toEqual({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
      });
    });

    test('should return 403 for viewer role (lacks tenant:manage_settings)', async () => {
      const viewerApp = createApp(VIEWER_CONTEXT);
      const response = await request(viewerApp).get('/api/admin/runtime/sessions');
      expect(response.status).toBe(403);
      expect(response.body.error).toEqual({
        code: 'PERMISSION_REQUIRED',
        message: 'Forbidden',
      });
    });

    test('should return 403 for viewer on stats endpoint', async () => {
      const viewerApp = createApp(VIEWER_CONTEXT);
      const response = await request(viewerApp).get('/api/admin/runtime/sessions/stats');
      expect(response.status).toBe(403);
    });

    test('should return 403 for viewer on session detail endpoint', async () => {
      const viewerApp = createApp(VIEWER_CONTEXT);
      const response = await request(viewerApp).get('/api/admin/runtime/sessions/session-123');
      expect(response.status).toBe(403);
    });

    test('should allow OWNER role (has *:* which covers tenant:manage_settings)', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);
      vi.mocked(countSessions).mockResolvedValue(0);
      const response = await request(app).get('/api/admin/runtime/sessions');
      expect(response.status).toBe(200);
    });
  });
});

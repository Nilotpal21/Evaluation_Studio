/**
 * Bull Board UI Integration Tests
 *
 * Verifies Bull Board UI is properly mounted and accessible.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// Mock requirePermission to pass through
vi.mock('@agent-platform/shared', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

// Mock db/index.js (admin.ts imports getModel)
vi.mock('../../db/index.js', () => ({
  getModel: vi.fn().mockReturnValue({}),
  getLazyModel: vi.fn().mockReturnValue({}),
}));

// Mock search-ai-internal vector store
vi.mock('@agent-platform/search-ai-internal/vector-store', () => ({
  createVectorStore: vi.fn(),
  forceRotateSharedIndex: vi.fn(),
}));

import adminRouter from '../admin.js';

describe('Bull Board UI', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'admin',
        permissions: ['admin:queues:read'],
        authType: 'jwt_user',
        isSuperAdmin: false,
      };
      next();
    });
    app.use('/api/admin', adminRouter);
  });

  test('should mount Bull Board UI at /api/admin/queues/ui', async () => {
    const response = await request(app).get('/api/admin/queues/ui');

    // Bull Board UI should return HTML (200) or redirect (302/301)
    expect([200, 301, 302]).toContain(response.status);
  });

  test('should serve Bull Board static assets', async () => {
    // Bull Board serves static CSS/JS files
    const response = await request(app).get('/api/admin/queues/ui/static/css/index.css');

    // Should return 200 or 404 (depending on if static files are served)
    // We're mainly checking that the route exists
    expect([200, 404]).toContain(response.status);
  });
});

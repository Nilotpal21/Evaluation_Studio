/**
 * Unit tests for the facade-specific feature gate (requireFacadeFeature).
 *
 * Uses DI — the `resolveFeature` dependency is injected directly.
 * No vi.mock of platform packages.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { requireFacadeFeature } from '../../../services/agent-assist/feature-gate.js';

function buildApp(opts: {
  resolveFeature: (tenantId: string, orgId: string | undefined) => Promise<boolean>;
  resolveProjectEnabled?: (tenantId: string, projectId: string) => Promise<boolean | null>;
  tenantId?: string;
  orgId?: string;
}) {
  const app = express();

  const gate = requireFacadeFeature({
    resolveFeature: opts.resolveFeature,
    resolveProjectEnabled: opts.resolveProjectEnabled,
  });

  // Stub auth middleware — populates tenantContext
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { tenantContext?: Record<string, unknown> }).tenantContext = {
      tenantId: opts.tenantId ?? 'T1',
      orgId: opts.orgId,
    };
    next();
  });

  // Protected endpoint without appId — gate on app level
  app.get('/test', gate, (_req: Request, res: Response) => {
    res.status(200).json({ success: true, data: { reached: true } });
  });

  // Protected endpoint WITH appId param (facade pattern)
  // Use a Router so Express populates req.params.appId before the gate runs
  const facadeRouter = express.Router({ mergeParams: true });
  facadeRouter.use(gate);
  facadeRouter.get('/test', (_req: Request, res: Response) => {
    res.status(200).json({ success: true, data: { reached: true } });
  });
  app.use('/apps/:appId', facadeRouter);

  return app;
}

describe('requireFacadeFeature', () => {
  it('calls next() when feature is granted via Deal', async () => {
    const app = buildApp({
      resolveFeature: async () => true,
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.data.reached).toBe(true);
  });

  it('returns 404 APP_NOT_FOUND when feature is not granted', async () => {
    const app = buildApp({
      resolveFeature: async () => false,
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('APP_NOT_FOUND');
  });

  it('returns 404 APP_NOT_FOUND on DB error (fail-closed)', async () => {
    const app = buildApp({
      resolveFeature: async () => {
        throw new Error('DB connection lost');
      },
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('APP_NOT_FOUND');
  });

  it('returns 404 when no tenantContext is present', async () => {
    const app = express();
    // No auth middleware — no tenantContext
    app.use(requireFacadeFeature({ resolveFeature: async () => true }));
    app.get('/test', (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('APP_NOT_FOUND');
  });

  // ─── Project-level enable/disable (Pass 2) ───────────────────────────

  describe('project-level feature gate', () => {
    it('allows access when project is enabled', async () => {
      const app = buildApp({
        resolveFeature: async () => true,
        resolveProjectEnabled: async () => true,
      });
      const res = await request(app).get('/apps/proj-1/test');
      expect(res.status).toBe(200);
      expect(res.body.data.reached).toBe(true);
    });

    it('returns 404 when project is explicitly disabled', async () => {
      const app = buildApp({
        resolveFeature: async () => true,
        resolveProjectEnabled: async () => false,
      });
      const res = await request(app).get('/apps/proj-1/test');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('APP_NOT_FOUND');
    });

    it('fails open when no project settings doc exists (null)', async () => {
      const app = buildApp({
        resolveFeature: async () => true,
        resolveProjectEnabled: async () => null,
      });
      const res = await request(app).get('/apps/proj-1/test');
      expect(res.status).toBe(200);
      expect(res.body.data.reached).toBe(true);
    });

    it('tenant deny overrides project-level enable', async () => {
      const app = buildApp({
        resolveFeature: async () => false,
        resolveProjectEnabled: async () => true,
      });
      const res = await request(app).get('/apps/proj-1/test');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('APP_NOT_FOUND');
    });

    it('skips project check when no appId in URL params', async () => {
      let projectCheckCalled = false;
      const app = buildApp({
        resolveFeature: async () => true,
        resolveProjectEnabled: async () => {
          projectCheckCalled = true;
          return false;
        },
      });
      // /test has no :appId param — project check should not fire
      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
      expect(projectCheckCalled).toBe(false);
    });
  });
});

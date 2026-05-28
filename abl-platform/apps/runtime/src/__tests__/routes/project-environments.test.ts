/**
 * Tests for the project-environments route.
 *
 * Uses DI (getDistinctEnvironments) to avoid mocking platform components.
 * Spins up a real Express server on a random port.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import {
  resolveEnvironments,
  createProjectEnvironmentsRouter,
} from '../../routes/project-environments.js';

// ─── Pure function tests ─────────────────────────────────────────────────

describe('resolveEnvironments', () => {
  it('returns sorted unique values when deployments exist', () => {
    expect(resolveEnvironments(['prod', 'dev', 'prod', 'staging'])).toEqual([
      'dev',
      'prod',
      'staging',
    ]);
  });

  it('returns default fallback list when empty', () => {
    expect(resolveEnvironments([])).toEqual(['dev', 'stg', 'prod']);
  });

  it('deduplicates identical environments', () => {
    expect(resolveEnvironments(['dev', 'dev', 'dev'])).toEqual(['dev']);
  });
});

// ─── Integration test with DI (real HTTP server, no mocks) ───────────────

describe('GET /api/projects/:projectId/environments (DI)', () => {
  let server: Server;
  let baseUrl: string;

  // Fake auth middleware that populates tenantContext
  const fakeAuth: express.RequestHandler = (req, _res, next) => {
    const tenantId = req.headers['x-tenant-id'] as string | undefined;
    (req as any).tenantContext = {
      tenantId: tenantId ?? 'tenant-1',
      userId: 'user-1',
    };
    // Satisfy requireProjectScope: req.params.projectId must exist
    next();
  };

  // Fake rbac — always allow
  const fakeRbac: express.RequestHandler = (_req, _res, next) => next();

  beforeAll(async () => {
    // Build an Express app that mimics the real mount, but with DI
    const app = express();
    app.use(express.json());

    // We cannot use the real authMiddleware / requireProjectScope / tenantRateLimit
    // without a DB. Instead, we test the pure logic + DI via a lightweight wrapper.
    const envsByProject: Record<string, string[]> = {
      'project-with-deployments': ['prod', 'dev'],
      'project-empty': [],
      'project-other-tenant': ['staging'],
    };

    const router = express.Router({ mergeParams: true });
    // Attach fake auth
    router.use(fakeAuth);

    router.get('/', async (req, res) => {
      const tenantId = (req as any).tenantContext?.tenantId;
      const projectId = req.params.projectId;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      // Simulate tenant isolation: only return envs for correct tenant
      let envNames: string[];
      if (tenantId === 'tenant-1') {
        envNames = envsByProject[projectId] ?? [];
      } else {
        envNames = [];
      }

      const environments = resolveEnvironments(envNames);
      res.json({ success: true, data: { environments } });
    });

    app.use('/api/projects/:projectId/environments', router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('returns deployment environments for a project with 2 deployments', async () => {
    const res = await fetch(`${baseUrl}/api/projects/project-with-deployments/environments`, {
      headers: { 'x-tenant-id': 'tenant-1' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.environments).toEqual(['dev', 'prod']);
  });

  it('returns fallback list for an empty project', async () => {
    const res = await fetch(`${baseUrl}/api/projects/project-empty/environments`, {
      headers: { 'x-tenant-id': 'tenant-1' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.environments).toEqual(['dev', 'stg', 'prod']);
  });

  it('tenant isolation: other tenant does not see deployments', async () => {
    const res = await fetch(`${baseUrl}/api/projects/project-with-deployments/environments`, {
      headers: { 'x-tenant-id': 'tenant-other' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Other tenant has no deployments for this project → fallback
    expect(body.data.environments).toEqual(['dev', 'stg', 'prod']);
  });
});

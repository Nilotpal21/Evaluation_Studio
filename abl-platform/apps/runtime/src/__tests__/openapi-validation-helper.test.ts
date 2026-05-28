import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createExpressErrorHandler } from '@agent-platform/shared/middleware';
import { createRouteRegistry } from '@agent-platform/openapi';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';

describe('createOpenAPIRouter request validation', () => {
  it('attaches validated params, query, and body to res.locals when validation is enabled', async () => {
    const registry = createRouteRegistry();
    const openapi = createOpenAPIRouter(registry, {
      basePath: '/api/projects/:projectId',
      validateRequests: true,
    });

    openapi.route(
      'post',
      '/widgets',
      {
        query: z.object({ limit: z.coerce.number().int().positive() }),
        body: z.object({ name: z.string().trim(), enabled: z.coerce.boolean() }),
      },
      (req, res) => {
        res.json({
          raw: {
            params: req.params,
            query: req.query,
            body: req.body,
          },
          validated: getValidatedRequestData(res),
        });
      },
    );

    const app = express();
    app.use(express.json());
    app.use('/api/projects/:projectId', openapi.router);

    await request(app)
      .post('/api/projects/project-123/widgets?limit=7')
      .send({ name: '  Example widget  ', enabled: 'true' })
      .expect(200, {
        raw: {
          params: { projectId: 'project-123' },
          query: { limit: '7' },
          body: { name: '  Example widget  ', enabled: 'true' },
        },
        validated: {
          params: { projectId: 'project-123' },
          query: { limit: 7 },
          body: { name: 'Example widget', enabled: true },
        },
      });
  });

  it('uses explicit params schemas when provided', async () => {
    const registry = createRouteRegistry();
    const openapi = createOpenAPIRouter(registry, {
      basePath: '/api/projects',
      validateRequests: true,
    });

    openapi.route(
      'get',
      '/:projectId',
      {
        params: z.object({
          projectId: z.string().transform((value) => value.toUpperCase()),
        }),
      },
      (_req, res) => {
        res.json({ validated: getValidatedRequestData(res) });
      },
    );

    const app = express();
    app.use('/api/projects', openapi.router);

    await request(app)
      .get('/api/projects/project-abc')
      .expect(200, {
        validated: {
          params: { projectId: 'PROJECT-ABC' },
        },
      });
  });

  it('routes validation failures through centralized error handling and skips the handler', async () => {
    const registry = createRouteRegistry();
    const openapi = createOpenAPIRouter(registry, {
      basePath: '/api/example',
      validateRequests: true,
    });
    const handler = vi.fn((_req: express.Request, res: express.Response) => {
      res.json({ ok: true });
    });

    openapi.route(
      'post',
      '/widgets',
      {
        query: z.object({ limit: z.coerce.number().int().positive() }),
        body: z.object({ name: z.string().min(3) }),
      },
      handler,
    );

    const app = express();
    app.use(express.json());
    app.use('/api/example', openapi.router);
    app.use(createExpressErrorHandler());

    await request(app)
      .post('/api/example/widgets?limit=0')
      .send({ name: 'ok' })
      .expect(400, {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'limit: Number must be greater than 0',
        },
      });

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports custom validation error responders for compatibility-sensitive routes', async () => {
    const registry = createRouteRegistry();
    const openapi = createOpenAPIRouter(registry, {
      basePath: '/api/example',
      validateRequests: true,
      onValidationError: (error, _req, res) => {
        res.status(422).json({
          error: 'Invalid request',
          details: error.issues,
        });
      },
    });
    const handler = vi.fn((_req: express.Request, res: express.Response) => {
      res.json({ ok: true });
    });

    openapi.route(
      'post',
      '/widgets',
      {
        body: z.object({ name: z.string().min(3) }),
      },
      handler,
    );

    const app = express();
    app.use(express.json());
    app.use('/api/example', openapi.router);
    app.use(createExpressErrorHandler());

    const response = await request(app)
      .post('/api/example/widgets')
      .send({ name: 'ok' })
      .expect(422);

    expect(response.body.error).toBe('Invalid request');
    expect(response.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['name'],
        }),
      ]),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps routes unchanged when request validation is not enabled', async () => {
    const registry = createRouteRegistry();
    const openapi = createOpenAPIRouter(registry, {
      basePath: '/api/example',
    });

    openapi.route(
      'post',
      '/widgets',
      {
        query: z.object({ limit: z.coerce.number().int().positive() }),
        body: z.object({ name: z.string().min(3) }),
      },
      (req, res) => {
        res.json({
          raw: {
            query: req.query,
            body: req.body,
          },
          validated: getValidatedRequestData(res) ?? null,
        });
      },
    );

    const app = express();
    app.use(express.json());
    app.use('/api/example', openapi.router);
    app.use(createExpressErrorHandler());

    await request(app)
      .post('/api/example/widgets?limit=0')
      .send({ name: 'ok' })
      .expect(200, {
        raw: {
          query: { limit: '0' },
          body: { name: 'ok' },
        },
        validated: null,
      });
  });

  it('preserves existing openapi locals when attaching validated data', async () => {
    const registry = createRouteRegistry();
    const openapi = createOpenAPIRouter(registry, {
      basePath: '/api/example',
      validateRequests: true,
    });

    openapi.route(
      'get',
      '/:itemId',
      {
        query: z.object({
          includeArchived: z.enum(['true', 'false']).transform((value) => value === 'true'),
        }),
      },
      (_req, res) => {
        res.json({ openapi: res.locals.openapi });
      },
    );

    const app = express();
    app.use((_, res, next) => {
      res.locals.openapi = { traceId: 'trace-123' } as typeof res.locals.openapi;
      next();
    });
    app.use('/api/example', openapi.router);

    await request(app)
      .get('/api/example/item-7?includeArchived=false')
      .expect(200, {
        openapi: {
          traceId: 'trace-123',
          validated: {
            params: { itemId: 'item-7' },
            query: { includeArchived: false },
          },
        },
      });
  });
});

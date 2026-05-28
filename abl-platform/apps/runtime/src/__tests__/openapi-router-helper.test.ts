import express, { type RequestHandler, type Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRouteRegistry } from '@agent-platform/openapi';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';

interface RouteStackLayer {
  handle: RequestHandler;
}

interface RouterLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean | undefined>;
    stack?: RouteStackLayer[];
  };
}

function getRouteHandles(router: Router, path: string, method: string): RequestHandler[] {
  const stack = Reflect.get(router, 'stack') as RouterLayer[];
  const layer = stack.find(
    (entry) => entry.route?.path === path && entry.route?.methods?.[method.toLowerCase()] === true,
  );

  return layer?.route?.stack?.map((routeLayer) => routeLayer.handle) ?? [];
}

describe('createOpenAPIRouter', () => {
  it('registers routes in the OpenAPI registry with basePath and default tags', async () => {
    const registry = createRouteRegistry();
    const openapi = createOpenAPIRouter(registry, {
      basePath: '/api/example',
      tags: ['Example'],
    });

    openapi.route(
      'get',
      '/ping',
      {
        summary: 'Ping',
        response: z.object({ ok: z.literal(true) }),
      },
      (_req, res) => {
        res.json({ ok: true });
      },
    );

    const app = express();
    app.use('/api/example', openapi.router);

    await request(app).get('/api/example/ping').expect(200, { ok: true });

    const spec = registry.generateSpec({
      title: 'OpenAPI Router Helper Test',
      version: '1.0.0',
    }) as {
      paths?: Record<string, { get?: { summary?: string; tags?: string[] } }>;
    };

    expect(spec.paths?.['/api/example/ping']?.get?.summary).toBe('Ping');
    expect(spec.paths?.['/api/example/ping']?.get?.tags).toEqual(['Example']);
  });

  it('lets route-level tags override router default tags', () => {
    const registry = createRouteRegistry();
    const openapi = createOpenAPIRouter(registry, {
      basePath: '/api/example',
      tags: ['DefaultTag'],
    });

    openapi.route(
      'get',
      '/custom-tag',
      {
        tags: ['CustomTag'],
        response: z.object({ ok: z.boolean() }),
      },
      (_req, res) => {
        res.json({ ok: true });
      },
    );

    const spec = registry.generateSpec({
      title: 'OpenAPI Router Helper Test',
      version: '1.0.0',
    }) as {
      paths?: Record<string, { get?: { tags?: string[] } }>;
    };

    expect(spec.paths?.['/api/example/custom-tag']?.get?.tags).toEqual(['CustomTag']);
  });

  it('keeps raw handler references by default', () => {
    const registry = createRouteRegistry();
    const openapi = createOpenAPIRouter(registry);
    const handler: RequestHandler = (_req, res) => {
      res.json({ ok: true });
    };

    openapi.route('get', '/raw', undefined, handler);

    expect(getRouteHandles(openapi.router, '/raw', 'get')).toEqual([handler]);
  });

  it('wraps async handlers only when explicitly enabled and forwards rejections to error middleware', async () => {
    const registry = createRouteRegistry();
    const openapi = createOpenAPIRouter(registry, { wrapAsyncHandlers: true });
    const handler: RequestHandler = async () => {
      throw new Error('async boom');
    };

    openapi.route('get', '/boom', undefined, handler);

    const registeredHandlers = getRouteHandles(openapi.router, '/boom', 'get');
    expect(registeredHandlers).toHaveLength(1);
    expect(registeredHandlers[0]).not.toBe(handler);

    const app = express();
    app.use(openapi.router);
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      },
    );

    await request(app).get('/boom').expect(500, { error: 'async boom' });
  });
});

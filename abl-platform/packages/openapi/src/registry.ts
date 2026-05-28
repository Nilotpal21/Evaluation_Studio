import {
  OpenApiGeneratorV3,
  OpenAPIRegistry,
  extendZodWithOpenApi,
  type RouteConfig,
  type ResponseConfig,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import type { RouteMetadata, RouteSchema, SpecOptions, HttpMethod } from './types.js';
import { pathParamsSchema } from './shared/schema-utils.js';

// Extend Zod once at module level
extendZodWithOpenApi(z);

const errorResponseSchema = z
  .object({
    error: z.string(),
  })
  .openapi('ErrorResponse');

export interface RouteRegistry {
  /** Register a route with its OpenAPI metadata */
  registerRoute(method: HttpMethod, path: string, schema?: RouteSchema): void;
  /** Check if a route is already registered */
  hasRoute(method: HttpMethod, path: string): boolean;
  /** Generate the full OpenAPI 3.0 spec document */
  generateSpec(options: SpecOptions): Record<string, unknown>;
}

export function createRouteRegistry(): RouteRegistry {
  const registry = new OpenAPIRegistry();
  const routes: RouteMetadata[] = [];
  const routeKeys = new Set<string>();

  // Register BearerAuth security scheme
  registry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  function registerRoute(method: HttpMethod, path: string, schema: RouteSchema = {}): void {
    const key = `${method.toUpperCase()} ${path}`;
    if (routeKeys.has(key)) return;
    routeKeys.add(key);

    const metadata: RouteMetadata = { method, path, schema };
    routes.push(metadata);

    // Build the zod-to-openapi route config
    const paramsZod = schema.params ?? pathParamsSchema(path);
    const successStatus = schema.successStatus ?? 200;
    const auth = schema.auth !== false; // default true

    const request: RouteConfig['request'] = {};
    if (paramsZod) {
      request.params = paramsZod as RouteConfig['request'] extends { params?: infer P } ? P : never;
    }
    if (schema.query) {
      request.query = schema.query as RouteConfig['request'] extends { query?: infer Q }
        ? Q
        : never;
    }
    if (schema.body && (method === 'post' || method === 'put' || method === 'patch')) {
      request.body = {
        content: {
          'application/json': {
            schema: schema.body,
          },
        },
      };
    }

    const responseContent = schema.responseContentType ?? 'application/json';
    const responseSchema = schema.response ?? z.object({}).passthrough();

    const successResponse: ResponseConfig = {
      description: 'Success',
      content:
        responseContent === 'text/event-stream'
          ? { 'text/event-stream': { schema: z.string() } }
          : { 'application/json': { schema: responseSchema } },
    };

    const errorResponse: ResponseConfig = {
      description: 'Unauthorized',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    };

    const serverErrorResponse: ResponseConfig = {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
    };

    const responses: RouteConfig['responses'] = {
      [successStatus]: successResponse,
      401: errorResponse,
      500: serverErrorResponse,
    };

    const hasRequest = paramsZod || schema.query || schema.body;

    registry.registerPath({
      method,
      path,
      summary: schema.summary ?? `${method.toUpperCase()} ${path}`,
      description: schema.description,
      tags: schema.tags ?? [deriveTag(path)],
      ...(hasRequest ? { request } : {}),
      responses,
      ...(auth ? { security: [{ BearerAuth: [] }] } : {}),
    });
  }

  function hasRoute(method: HttpMethod, path: string): boolean {
    return routeKeys.has(`${method.toUpperCase()} ${path}`);
  }

  function generateSpec(options: SpecOptions): Record<string, unknown> {
    const generator = new OpenApiGeneratorV3(registry.definitions);
    const doc = generator.generateDocument({
      openapi: '3.0.3',
      info: {
        title: options.title,
        version: options.version,
        description: options.description,
      },
      servers: options.servers,
    });
    return doc as unknown as Record<string, unknown>;
  }

  return { registerRoute, hasRoute, generateSpec };
}

/**
 * Derive a tag from the first meaningful path segment.
 * `/api/v1/chat/stream` → `Chat`
 * `/api/projects/:id/agents` → `Projects`
 */
function deriveTag(path: string): string {
  const segments = path.split('/').filter(Boolean);
  // Skip 'api' prefix if present
  const start = segments[0] === 'api' ? 1 : 0;
  const segment = segments[start] ?? 'default';
  // Capitalize
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

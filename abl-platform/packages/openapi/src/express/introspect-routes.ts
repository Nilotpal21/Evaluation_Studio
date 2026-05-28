import type { Express } from 'express';
import type { RouteRegistry } from '../registry.js';
import type { HttpMethod } from '../types.js';
import { expressPathToOpenAPI } from '../shared/schema-utils.js';

interface ExpressLayer {
  name: string;
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
  handle?: {
    stack?: ExpressLayer[];
  };
  regexp?: RegExp;
  keys?: Array<{ name: string }>;
  path?: string;
}

/**
 * Walk the Express router stack and register any routes not yet in the registry.
 * Call this **after** all routes are mounted so the full stack is available.
 *
 * Routes discovered this way get minimal metadata (method + path + auto-tag).
 * Adding Zod schemas via `createOpenAPIRouter` gives richer documentation.
 */
export function introspectExpressRoutes(app: Express, registry: RouteRegistry): void {
  const router = (app as unknown as { _router?: { stack?: ExpressLayer[] } })._router;
  if (!router?.stack) return;

  walkStack(router.stack, '', registry);
}

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

function walkStack(stack: ExpressLayer[], prefix: string, registry: RouteRegistry): void {
  for (const layer of stack) {
    if (layer.route) {
      // Direct route
      const routePath = prefix + layer.route.path;
      const openApiPath = expressPathToOpenAPI(routePath);

      for (const method of HTTP_METHODS) {
        if (layer.route.methods[method]) {
          if (!registry.hasRoute(method, openApiPath)) {
            registry.registerRoute(method, openApiPath);
          }
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      // Nested router — extract the mount path from the regexp
      const mountPath = extractMountPath(layer);
      walkStack(layer.handle.stack, prefix + mountPath, registry);
    }
  }
}

/**
 * Extract the mount path from an Express router layer.
 * Express stores the path as a regexp; we reconstruct it from the keys + regexp source.
 */
function extractMountPath(layer: ExpressLayer): string {
  // If the layer has a path property directly, use it
  if (layer.path) return layer.path;

  // Try to reconstruct from the regexp
  if (layer.regexp && layer.keys) {
    let source = layer.regexp.source;
    // Remove regex anchors and escaping
    source = source
      .replace(/^\^\\\//, '/')
      .replace(/\\\/\?\(\?\=\\\/\|\$\)$/, '')
      .replace(/\(\?\:\(\[\^\\\/\]\+\?\)\)/, '');
    // Replace param captures with :paramName
    if (layer.keys.length > 0) {
      let idx = 0;
      source = source.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => {
        const key = layer.keys![idx++];
        return key ? `:${key.name}` : ':param';
      });
    }
    // Clean up remaining regex artifacts
    source = source.replace(/\\\//g, '/');
    if (source && source !== '/') return source;
  }

  return '';
}

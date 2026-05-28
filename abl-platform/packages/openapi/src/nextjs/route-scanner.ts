import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { RouteRegistry } from '../registry.js';
import type { HttpMethod } from '../types.js';
import { nextjsPathToOpenAPI } from '../shared/schema-utils.js';
import { getOpenAPIMetadata } from './with-openapi.js';

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

export interface ScanOptions {
  /** Absolute path to the `src/app/api` directory */
  apiDir: string;
  /** Base path prefix (default `/api`) */
  basePath?: string;
}

/**
 * Scan Next.js App Router `route.ts` files and register discovered routes.
 *
 * For each `route.ts`, it checks for exported HTTP method handlers (GET, POST, etc.).
 * If a handler was wrapped with `withOpenAPI()`, its schema is used.
 * Otherwise the route is registered with basic method + path info.
 */
export async function scanNextjsRoutes(
  registry: RouteRegistry,
  options: ScanOptions,
): Promise<void> {
  const { apiDir, basePath = '/api' } = options;
  const routeFiles = await findRouteFiles(apiDir);

  for (const filePath of routeFiles) {
    const relPath = relative(apiDir, filePath);
    // Remove `/route.ts` suffix and convert to URL path
    const dirPath = relPath.replace(/[/\\]route\.[tj]s$/, '');
    const urlPath = dirPath ? `${basePath}/${dirPath}` : basePath;
    const openApiPath = nextjsPathToOpenAPI(urlPath);

    // Dynamic-import the route module
    let routeModule: Record<string, unknown>;
    try {
      routeModule = await import(filePath);
    } catch {
      // If the module fails to import (missing deps at scan time), skip it
      continue;
    }

    // Check each HTTP method export
    for (const method of HTTP_METHODS) {
      const handler = routeModule[method.toUpperCase()];
      if (typeof handler !== 'function') continue;

      if (registry.hasRoute(method, openApiPath)) continue;

      const metadata = getOpenAPIMetadata(handler);
      registry.registerRoute(method, openApiPath, metadata);
    }
  }
}

/** Recursively find all `route.ts` / `route.js` files under a directory */
async function findRouteFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const s = await stat(fullPath);
    if (s.isDirectory()) {
      results.push(...(await findRouteFiles(fullPath)));
    } else if (entry === 'route.ts' || entry === 'route.js') {
      results.push(fullPath);
    }
  }

  return results;
}

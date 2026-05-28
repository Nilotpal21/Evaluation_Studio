import { z } from 'zod';

/**
 * Convert Express-style path params (`:param`) to OpenAPI `{param}` format.
 * Example: `/api/users/:id/posts/:postId` → `/api/users/{id}/posts/{postId}`
 */
export function expressPathToOpenAPI(path: string): string {
  return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
}

/**
 * Convert Next.js-style dynamic segments (`[param]`) to OpenAPI `{param}` format.
 * Example: `/api/projects/[id]/agents/[agentId]` → `/api/projects/{id}/agents/{agentId}`
 */
export function nextjsPathToOpenAPI(path: string): string {
  return path.replace(/\[([a-zA-Z_][a-zA-Z0-9_]*)\]/g, '{$1}');
}

/**
 * Extract path parameter names from an OpenAPI-style path and return a
 * Zod object schema with `z.string()` for each one.
 */
export function pathParamsSchema(
  openApiPath: string,
): z.ZodObject<Record<string, z.ZodString>> | undefined {
  const paramNames = [...openApiPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  if (paramNames.length === 0) return undefined;

  const shape: Record<string, z.ZodString> = {};
  for (const name of paramNames) {
    shape[name] = z.string();
  }
  return z.object(shape);
}

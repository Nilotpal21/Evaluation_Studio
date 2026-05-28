import type { RouteSchema } from '../types.js';

/** Symbol used to attach OpenAPI metadata to Next.js route handlers */
const OPENAPI_KEY = '__openapi';

export interface OpenAPIHandler {
  (...args: unknown[]): unknown;
  [key: string]: unknown;
}

/**
 * Wrap a Next.js route handler with OpenAPI metadata.
 * The handler's behavior is unchanged — this only attaches schema info
 * so the route scanner can pick it up.
 *
 * Usage:
 * ```ts
 * export const POST = withOpenAPI({
 *   summary: 'Create a project',
 *   body: createProjectSchema,
 *   response: projectResponseSchema,
 * }, async (request: NextRequest) => {
 *   // handler unchanged
 * });
 * ```
 */
export function withOpenAPI<T extends (...args: unknown[]) => unknown>(
  schema: RouteSchema,
  handler: T,
): T {
  (handler as unknown as Record<string, unknown>)[OPENAPI_KEY] = schema;
  return handler;
}

/** Extract OpenAPI metadata from a handler, if present */
export function getOpenAPIMetadata(handler: unknown): RouteSchema | undefined {
  if (typeof handler === 'function' && OPENAPI_KEY in handler) {
    return (handler as Record<string, unknown>)[OPENAPI_KEY] as RouteSchema;
  }
  return undefined;
}

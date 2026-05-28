export { createRouteRegistry } from './registry.js';
export type { RouteRegistry } from './registry.js';
export type { RouteSchema, RouteMetadata, SpecOptions, HttpMethod } from './types.js';
export {
  expressPathToOpenAPI,
  nextjsPathToOpenAPI,
  pathParamsSchema,
} from './shared/schema-utils.js';

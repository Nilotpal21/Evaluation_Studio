import type { ZodType } from 'zod';

/** HTTP methods supported by OpenAPI */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Zod schemas describing a single route's request/response contract */
export interface RouteSchema {
  summary?: string;
  description?: string;
  tags?: string[];
  /** Zod schema for path parameters */
  params?: ZodType;
  /** Zod schema for query string */
  query?: ZodType;
  /** Zod schema for JSON request body */
  body?: ZodType;
  /** Zod schema for the success response body */
  response?: ZodType;
  /** Override the success status code (default 200) */
  successStatus?: number;
  /** Whether this route requires Bearer auth (default true) */
  auth?: boolean;
  /** Override response content type (e.g. 'text/event-stream') */
  responseContentType?: string;
}

/** A fully-resolved route entry stored in the registry */
export interface RouteMetadata {
  method: HttpMethod;
  /** OpenAPI-style path, e.g. /api/users/{id} */
  path: string;
  schema: RouteSchema;
}

/** Options for generating the OpenAPI spec document */
export interface SpecOptions {
  title: string;
  version: string;
  description?: string;
  servers?: Array<{ url: string; description?: string }>;
}

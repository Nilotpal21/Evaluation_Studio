/**
 * Request ID Middleware
 *
 * Generates a unique request ID for each incoming request and propagates it
 * via AsyncLocalStorage for correlation across logs, audit events, and traces.
 *
 * - Accepts client-provided X-Request-ID header (validated format)
 * - Generates a new one if not provided
 * - Sets X-Request-ID on the response for client correlation
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

const requestIdStorage = new AsyncLocalStorage<string>();

// Validate format: must be alphanumeric + hyphens, max 64 chars
const VALID_REQUEST_ID = /^[a-zA-Z0-9\-]{1,64}$/;

/**
 * Options for the request ID middleware.
 */
export interface RequestIdMiddlewareOptions {
  /** Paths to exclude from request ID assignment (e.g. health checks, metrics) */
  excludePaths?: string[];
}

/**
 * Express middleware that assigns a request ID to each request.
 */
export function requestIdMiddleware(options?: RequestIdMiddlewareOptions): RequestHandler {
  const excluded = new Set(options?.excludePaths ?? []);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (excluded.size > 0 && excluded.has(req.path)) {
      return next();
    }

    const clientId = req.headers['x-request-id'] as string | undefined;
    const requestId = clientId && VALID_REQUEST_ID.test(clientId) ? clientId : crypto.randomUUID();

    res.setHeader('X-Request-ID', requestId);

    requestIdStorage.run(requestId, () => next());
  };
}

/**
 * Get the current request ID from AsyncLocalStorage.
 * Returns undefined if not within a request context.
 */
export function getCurrentRequestId(): string | undefined {
  return requestIdStorage.getStore();
}

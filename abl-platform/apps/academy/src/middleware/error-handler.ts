/**
 * Error Handler Middleware (Academy Service)
 *
 * Central error handler using AppError/errorToResponse from shared-kernel.
 * Follows the same pattern as template-store's error handler.
 */

import type { Request, Response, NextFunction } from 'express';
import { errorToResponse } from '@agent-platform/shared-kernel';
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('academy-error');

/**
 * Express error-handling middleware (4-argument signature).
 * Must be registered LAST in the middleware chain.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  log.error('Server error', { error: err.message, stack: err.stack });
  const { statusCode, body } = errorToResponse(err);
  res.status(statusCode).json(body);
}

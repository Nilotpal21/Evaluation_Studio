/**
 * Trace Response Helper
 *
 * Injects the current traceId from AsyncLocalStorage into API response bodies,
 * enabling support engineers to correlate user-reported errors with trace data.
 */

import type { Response } from 'express';
import { getCurrentTraceId } from '@abl/compiler/platform/observability';

/**
 * Send a JSON response with `traceId` injected from the current ALS context.
 * If no traceId is available, the response is sent without it.
 */
export function sendWithTrace(
  res: Response,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  const traceId = getCurrentTraceId();
  if (traceId) {
    body.traceId = traceId;
  }
  res.status(statusCode).json(body);
}

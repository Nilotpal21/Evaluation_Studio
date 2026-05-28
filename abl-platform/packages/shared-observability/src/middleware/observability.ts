/**
 * Observability Middleware (Parameterized)
 *
 * Wraps each HTTP request in tracing context.
 * Parameterized so both Studio and Runtime can provide their own
 * logger, metrics recorder, and observability context runner.
 */

import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { parseTraceparent } from '../tracing/traceparent.js';

/**
 * Observability context shape.
 */
export interface ObservabilityContext {
  traceId: string;
  spanId: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  correlationId?: string;
}

/**
 * Configuration for the observability middleware.
 */
export interface ObservabilityMiddlewareConfig {
  /** Run a function within an observability context */
  runWithContext(ctx: ObservabilityContext, fn: () => void): void;
  /** Paths to exclude from observability wrapping (e.g. health checks, metrics) */
  excludePaths?: string[];
  /** Resolve tenant context for the current request (optional — injected by auth layer) */
  getTenantContext?(): { tenantId?: string; userId?: string } | undefined;
  /** Log request start */
  logRequestStart?(method: string, path: string, userAgent?: string): void;
  /** Log request end */
  logRequestEnd?(method: string, path: string, statusCode: number, durationMs: number): void;
  /** Record HTTP request metrics */
  recordMetrics?(info: {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
  }): void;
  /** Increment active request counter */
  incrementActive?(): void;
  /** Decrement active request counter */
  decrementActive?(): void;
}

/**
 * Create an Express observability middleware with injected dependencies.
 */
export function createObservabilityMiddleware(config: ObservabilityMiddlewareConfig) {
  const excluded = new Set(config.excludePaths ?? []);

  return function observabilityMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (excluded.size > 0 && excluded.has(req.path)) {
      return next();
    }

    const startTime = process.hrtime.bigint();

    const parsed = parseTraceparent(req.headers.traceparent as string | undefined);
    const traceId = parsed?.traceId ?? randomUUID().replace(/-/g, '');
    const spanId = parsed?.spanId ?? randomUUID().replace(/-/g, '').slice(0, 16);

    const tenantCtx = config.getTenantContext?.();

    const ctx: ObservabilityContext = {
      traceId,
      spanId,
      tenantId: tenantCtx?.tenantId,
      userId: tenantCtx?.userId,
      sessionId: req.headers['x-session-id'] as string | undefined,
      correlationId: req.headers['x-correlation-id'] as string | undefined,
    };

    res.setHeader('X-Trace-Id', traceId);

    config.runWithContext(ctx, () => {
      config.incrementActive?.();

      config.logRequestStart?.(req.method, req.path, req.headers['user-agent']);

      res.on('finish', () => {
        const durationNs = process.hrtime.bigint() - startTime;
        const durationMs = Number(durationNs / 1_000_000n);

        config.decrementActive?.();
        config.recordMetrics?.({
          method: req.method,
          route: req.route?.path ?? req.path,
          statusCode: res.statusCode,
          durationMs,
        });

        config.logRequestEnd?.(req.method, req.path, res.statusCode, durationMs);
      });

      next();
    });
  };
}

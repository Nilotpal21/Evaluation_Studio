/**
 * Slow Query Detection Plugin
 *
 * Mongoose-level plugin that measures operation wall-clock time
 * and logs queries exceeding the configured threshold.
 *
 * Complements the APM command monitoring in MongoConnectionManager
 * by providing Mongoose-level context (collection name, filter).
 */

import type { Schema, Query, Aggregate } from 'mongoose';

// ─── Configuration ───────────────────────────────────────────────────────

let slowQueryThresholdMs = 200;

/**
 * Set the slow query detection threshold.
 */
export function setSlowQueryThreshold(ms: number): void {
  slowQueryThresholdMs = ms;
}

// ─── Logger ──────────────────────────────────────────────────────────────

interface SlowQueryLog {
  collection: string;
  operation: string;
  durationMs: number;
  threshold: number;
  filter?: Record<string, unknown>;
}

let logHandler: (log: SlowQueryLog) => void = (log) => {
  console.warn(
    `[SLOW_QUERY] collection=${log.collection} op=${log.operation} ` +
      `duration=${log.durationMs}ms threshold=${log.threshold}ms` +
      (log.filter ? ` filter=${JSON.stringify(redactFilter(log.filter))}` : ''),
  );
};

/**
 * Override the slow query log handler (for integration with platform logger).
 */
export function setSlowQueryLogHandler(handler: (log: SlowQueryLog) => void): void {
  logHandler = handler;
}

// ─── Filter Redaction ────────────────────────────────────────────────────

const REDACT_KEYS = new Set(['password', 'secret', 'token', 'apiKey', 'api_key', 'credential']);

function redactFilter(filter: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (REDACT_KEYS.has(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = redactFilter(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Plugin ──────────────────────────────────────────────────────────────

const TIMED_SYMBOL = Symbol('slowQueryStart');

/**
 * Mongoose plugin for slow query detection.
 *
 * Usage:
 *   schema.plugin(slowQueryPlugin);
 */
export function slowQueryPlugin(schema: Schema): void {
  // ── Query Operations ───────────────────────────────────────────────
  const queryOps = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'countDocuments',
    'distinct',
    'deleteOne',
    'deleteMany',
    'updateOne',
    'updateMany',
    'replaceOne',
  ] as const;

  for (const op of queryOps) {
    schema.pre(op, function (this: Query<any, any> & { [TIMED_SYMBOL]?: number }) {
      (this as any)[TIMED_SYMBOL] = Date.now();
    });

    schema.post(op, function (this: Query<any, any> & { [TIMED_SYMBOL]?: number }) {
      const start = (this as any)[TIMED_SYMBOL];
      if (start === undefined) return;

      const duration = Date.now() - start;
      if (duration >= slowQueryThresholdMs) {
        logHandler({
          collection: this.model?.collection?.name ?? 'unknown',
          operation: op,
          durationMs: duration,
          threshold: slowQueryThresholdMs,
          filter: this.getFilter?.() as Record<string, unknown>,
        });
      }
    });
  }

  // ── Save ───────────────────────────────────────────────────────────
  schema.pre('save', function (this: any) {
    this[TIMED_SYMBOL] = Date.now();
  });

  schema.post('save', function (this: any) {
    const start = this[TIMED_SYMBOL];
    if (start === undefined) return;

    const duration = Date.now() - start;
    if (duration > slowQueryThresholdMs) {
      logHandler({
        collection: this.constructor?.collection?.name ?? 'unknown',
        operation: 'save',
        durationMs: duration,
        threshold: slowQueryThresholdMs,
      });
    }
  });

  // ── Aggregate ──────────────────────────────────────────────────────
  schema.pre('aggregate', function (this: Aggregate<any> & { [TIMED_SYMBOL]?: number }) {
    (this as any)[TIMED_SYMBOL] = Date.now();
  });

  schema.post('aggregate', function (this: Aggregate<any> & { [TIMED_SYMBOL]?: number }) {
    const start = (this as any)[TIMED_SYMBOL];
    if (start === undefined) return;

    const duration = Date.now() - start;
    if (duration > slowQueryThresholdMs) {
      logHandler({
        collection: (this as any)._model?.collection?.name ?? 'unknown',
        operation: 'aggregate',
        durationMs: duration,
        threshold: slowQueryThresholdMs,
      });
    }
  });
}

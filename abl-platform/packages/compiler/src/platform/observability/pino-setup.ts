/**
 * Pino Logger Setup
 *
 * Creates a singleton Pino instance with:
 * - ALS mixin for automatic observability context injection
 * - Sensitive field redaction
 * - Two output formats controlled by LOG_FORMAT env var:
 *     "json"   → structured JSON (default in production)
 *     "simple" → "level: message" with timestamp (default in development)
 * - Log level from LOG_LEVEL env var (default: "debug" in dev, "info" in prod)
 */

import pino from 'pino';
import { getObservabilityContext } from './context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PinoOptions {
  level?: string;
  /** Additional redact paths beyond the defaults */
  redactPaths?: string[];
  /** Pretty-print in development (requires pino-pretty installed) */
  pretty?: boolean;
  /** Log format: 'json' for structured, 'simple' for "level: message" */
  format?: 'json' | 'simple';
}

// ---------------------------------------------------------------------------
// Env-based defaults
// ---------------------------------------------------------------------------

const isDev = (process.env.NODE_ENV || 'development') !== 'production';
const envLogLevel = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');
const envLogFormat = (process.env.LOG_FORMAT || (isDev ? 'simple' : 'json')) as 'json' | 'simple';

// ---------------------------------------------------------------------------
// Simple format writer — outputs "LEVEL [timestamp] module: message  key=val"
// ---------------------------------------------------------------------------

function buildSimpleDestination(): pino.DestinationStream {
  return {
    write(chunk: string) {
      try {
        const obj = JSON.parse(chunk);
        const level = (obj.level || 'info').toUpperCase().padEnd(5);
        const ts = obj.time
          ? new Date(obj.time).toISOString().replace('T', ' ').replace('Z', '')
          : '';
        const mod = obj.module ? `[${obj.module}]` : '';
        const msg = obj.msg || '';

        // Collect extra data keys (skip pino internals)
        const skip = new Set([
          'level',
          'time',
          'pid',
          'hostname',
          'module',
          'msg',
          'correlationId',
          'traceId',
          'spanId',
          'tenantId',
          'sessionId',
          'userId',
        ]);
        const extras: string[] = [];
        for (const [k, v] of Object.entries(obj)) {
          if (!skip.has(k) && v !== undefined && v !== null) {
            extras.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
          }
        }

        const extraStr = extras.length > 0 ? `  ${extras.join(' ')}` : '';
        process.stdout.write(`${level} ${ts} ${mod} ${msg}${extraStr}\n`);
      } catch {
        // Fallback: write raw chunk if not valid JSON
        process.stdout.write(chunk);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let rootLogger: pino.Logger | null = null;

/**
 * Initialize the root Pino logger. Call once at startup.
 * Subsequent calls return the existing instance.
 */
export function initPino(opts: PinoOptions = {}): pino.Logger {
  if (rootLogger) return rootLogger;

  const level = opts.level ?? envLogLevel;
  const format = opts.format ?? envLogFormat;

  const defaultRedactPaths = [
    'password',
    'secret',
    'token',
    'apiKey',
    'api_key',
    'authorization',
    'credential',
    'credentials',
    'ssn',
    'creditCard',
    'cardNumber',
    'cvv',
    'pin',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'privateKey',
    'private_key',
  ];

  const redactPaths = [...defaultRedactPaths, ...(opts.redactPaths ?? [])];

  const pinoOpts: pino.LoggerOptions = {
    level,

    // Auto-inject observability context on every log call
    mixin() {
      const ctx = getObservabilityContext();
      if (!ctx) return {};
      const result: Record<string, string> = {
        traceId: ctx.traceId,
        spanId: ctx.spanId,
      };
      if (ctx.tenantId) result.tenantId = ctx.tenantId;
      if (ctx.sessionId) result.sessionId = ctx.sessionId;
      if (ctx.userId) result.userId = ctx.userId;
      if (ctx.correlationId) result.correlationId = ctx.correlationId;
      return result;
    },

    // Redact sensitive fields at any nesting depth
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },

    // ISO timestamp for structured log aggregation
    timestamp: pino.stdTimeFunctions.isoTime,

    // Emit string level names ("info") instead of numeric (30)
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  };

  if (format === 'simple') {
    rootLogger = pino(pinoOpts, buildSimpleDestination());
  } else if (opts.pretty) {
    rootLogger = pino({
      ...pinoOpts,
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  } else {
    rootLogger = pino(pinoOpts);
  }

  return rootLogger;
}

/**
 * Get the root Pino instance.
 * Auto-initializes with env-based defaults if not yet initialized.
 */
export function getPino(level?: string): pino.Logger {
  if (!rootLogger) {
    return initPino({ level: level ?? envLogLevel });
  }
  return rootLogger;
}

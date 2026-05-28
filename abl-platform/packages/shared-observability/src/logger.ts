/**
 * Structured Logger for Agent Platform
 *
 * Canonical logger implementation shared across all packages.
 * Provides the `createLogger` API with:
 * - Pino-backed structured JSON output
 * - Sensitive field redaction (both field-name and pattern-based)
 * - Correlation ID propagation (via `getCurrentRequestId` or manual `setCorrelationId`)
 * - Child logger support
 * - Global log level and custom handler overrides
 * - LOG_LEVEL / LOG_FORMAT env-based defaults
 *
 * Usage:
 *   import { createLogger } from '@agent-platform/shared-observability';
 *   const log = createLogger('auth-profile-service');
 *   log.info('Profile created', { profileId, authType });
 */

import pino from 'pino';
import { getCurrentRequestId } from './middleware/request-id.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  timestamp: string;
  correlationId?: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(metadata: Record<string, unknown>): Logger;
  setCorrelationId(id: string): void;
}

// ---------------------------------------------------------------------------
// Env defaults
// ---------------------------------------------------------------------------

const isDev = (process.env.NODE_ENV || 'development') !== 'production';
const envLogLevel = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');
const envLogFormat = (process.env.LOG_FORMAT || (isDev ? 'simple' : 'json')) as 'json' | 'simple';

// ---------------------------------------------------------------------------
// Sensitive field redaction
// ---------------------------------------------------------------------------

const SENSITIVE_FIELDS = new Set([
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'ssn',
  'social_security',
  'credit_card',
  'creditCard',
  'cardNumber',
  'card_number',
  'cvv',
  'pin',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'privateKey',
  'private_key',
  'encryptedSecrets',
]);

// Patterns to redact from values — labels MUST match trace-scrubber labels
const SENSITIVE_PATTERNS = [
  // PII patterns
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: '[REDACTED_EMAIL]',
  },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED_SSN]' },
  {
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    replacement: '[REDACTED_CARD]',
  },
  {
    pattern: /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    replacement: '[REDACTED_PHONE]',
    validate: (match: string) => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15;
    },
  },
  // Secret / credential patterns
  { pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g, replacement: 'Bearer [REDACTED]' },
  { pattern: /\bsk-[A-Za-z0-9]{8,}/g, replacement: '[REDACTED]' },
  { pattern: /\bghp_[A-Za-z0-9]{8,}/g, replacement: '[REDACTED]' },
  { pattern: /\bgho_[A-Za-z0-9]{8,}/g, replacement: '[REDACTED]' },
  { pattern: /\bAKIA[A-Z0-9]{12,}/g, replacement: '[REDACTED]' },
  { pattern: /\babl_[A-Za-z0-9]{8,}/g, replacement: '[REDACTED]' },
  { pattern: /\bpk_live_[A-Za-z0-9]{8,}/g, replacement: '[REDACTED]' },
  { pattern: /\bpk_test_[A-Za-z0-9]{8,}/g, replacement: '[REDACTED]' },
];

// Pino-level redact paths (field names only, for pino's built-in redaction)
const REDACT_PATHS = [
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'credential',
  'credentials',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'privateKey',
  'private_key',
  'encryptedSecrets',
];

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let globalMinLevel: LogLevel = 'debug';
let globalHandler: ((entry: LogEntry) => void) | null = null;

// ---------------------------------------------------------------------------
// Public: setLogLevel / setLogHandler / redactSensitive
// ---------------------------------------------------------------------------

/**
 * Set the global minimum log level.
 * Messages below this level are discarded.
 */
export function setLogLevel(level: LogLevel): void {
  globalMinLevel = level;
  // Sync Pino's level if already initialized
  if (rootLogger) {
    rootLogger.level = level;
  }
}

/**
 * Set a custom log handler. Passing null reverts to Pino output.
 * When set, log entries are routed to the handler instead of Pino.
 * This preserves backward compatibility for tests and custom integrations.
 */
export function setLogHandler(handler: ((entry: LogEntry) => void) | null): void {
  globalHandler = handler;
}

/**
 * Apply pattern-based redaction to a single string value.
 */
export function redactString(value: string): string {
  let redacted = value;
  for (const entry of SENSITIVE_PATTERNS) {
    entry.pattern.lastIndex = 0;
    if ('validate' in entry && entry.validate) {
      const validateFn = entry.validate as (match: string) => boolean;
      redacted = redacted.replace(entry.pattern, (match) =>
        validateFn(match) ? entry.replacement : match,
      );
    } else {
      redacted = redacted.replace(entry.pattern, entry.replacement);
    }
  }
  return redacted;
}

/**
 * Redact sensitive data from an object (deep clone).
 * Handles nested objects and arrays.
 */
export function redactSensitive(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      result[key] = redactString(value);
    } else if (Array.isArray(value)) {
      result[key] = redactArray(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Redact sensitive data from array elements.
 */
function redactArray(arr: unknown[]): unknown[] {
  return arr.map((item) => {
    if (typeof item === 'string') {
      return redactString(item);
    } else if (Array.isArray(item)) {
      return redactArray(item);
    } else if (typeof item === 'object' && item !== null) {
      return redactSensitive(item as Record<string, unknown>);
    }
    return item;
  });
}

// ---------------------------------------------------------------------------
// Simple format writer (matches compiler's simple format)
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

        const skip = new Set([
          'level',
          'time',
          'pid',
          'hostname',
          'module',
          'msg',
          'correlationId',
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
        process.stdout.write(chunk);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pino singleton
// ---------------------------------------------------------------------------

let rootLogger: pino.Logger | null = null;

function getRootLogger(): pino.Logger {
  if (rootLogger) return rootLogger;

  const pinoOpts: pino.LoggerOptions = {
    level: envLogLevel,

    mixin() {
      const requestId = getCurrentRequestId();
      return requestId ? { correlationId: requestId } : {};
    },

    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },

    timestamp: pino.stdTimeFunctions.isoTime,

    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  };

  if (envLogFormat === 'simple') {
    rootLogger = pino(pinoOpts, buildSimpleDestination());
  } else {
    rootLogger = pino(pinoOpts);
  }

  return rootLogger;
}

// ---------------------------------------------------------------------------
// Logger implementation
// ---------------------------------------------------------------------------

class LoggerImpl implements Logger {
  private module: string;
  private metadata: Record<string, unknown>;
  private correlationId?: string;
  private pinoChild: pino.Logger;

  constructor(
    module: string,
    pinoChild: pino.Logger,
    metadata: Record<string, unknown> = {},
    correlationId?: string,
  ) {
    this.module = module;
    this.pinoChild = pinoChild;
    this.metadata = metadata;
    this.correlationId = correlationId;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  child(metadata: Record<string, unknown>): Logger {
    const childPino = this.pinoChild.child(metadata);
    return new LoggerImpl(
      this.module,
      childPino,
      { ...this.metadata, ...metadata },
      this.correlationId,
    );
  }

  setCorrelationId(id: string): void {
    this.correlationId = id;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[globalMinLevel]) return;

    // Redact sensitive patterns from the message string itself
    const safeMessage = redactString(message);

    const mergedData = data
      ? redactSensitive({ ...this.metadata, ...data })
      : Object.keys(this.metadata).length > 0
        ? redactSensitive(this.metadata)
        : undefined;

    // Custom handler path (backward compat for tests/integrations)
    if (globalHandler) {
      const entry: LogEntry = {
        level,
        module: this.module,
        message: safeMessage,
        timestamp: new Date().toISOString(),
        correlationId: this.correlationId,
        data: mergedData,
      };
      globalHandler(entry);
      return;
    }

    // Pino path — structured JSON to stdout
    const pinoLogger = this.correlationId
      ? this.pinoChild.child({ correlationId: this.correlationId })
      : this.pinoChild;

    const logData = mergedData ?? {};
    switch (level) {
      case 'debug':
        pinoLogger.debug(logData, safeMessage);
        break;
      case 'info':
        pinoLogger.info(logData, safeMessage);
        break;
      case 'warn':
        pinoLogger.warn(logData, safeMessage);
        break;
      case 'error':
        pinoLogger.error(logData, safeMessage);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a structured logger for a module.
 *
 * @param module - Module name (e.g. 'auth-profile-service', 'token-refresh')
 * @param metadata - Optional default metadata merged into every log entry
 */
export function createLogger(module: string, metadata?: Record<string, unknown>): Logger {
  const child = getRootLogger().child({ module, ...metadata });
  return new LoggerImpl(module, child, metadata);
}

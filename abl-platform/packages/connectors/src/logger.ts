/**
 * Lightweight structured logger for the connectors package.
 *
 * Follows the same API shape as `createLogger` from `@abl/compiler/platform`
 * so that if the connectors package later gains that dependency, migration
 * is a one-line import change.
 */

export interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

function safeMeta(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return '[unserializable meta]';
  }
}

export function createLogger(module: string): Logger {
  const prefix = `[${module}]`;

  return {
    error(message: string, meta?: Record<string, unknown>) {
      console.error(prefix, message, meta ? safeMeta(meta) : '');
    },
    warn(message: string, meta?: Record<string, unknown>) {
      console.warn(prefix, message, meta ? safeMeta(meta) : '');
    },
    info(message: string, meta?: Record<string, unknown>) {
      console.info(prefix, message, meta ? safeMeta(meta) : '');
    },
    debug(message: string, meta?: Record<string, unknown>) {
      console.debug(prefix, message, meta ? safeMeta(meta) : '');
    },
  };
}

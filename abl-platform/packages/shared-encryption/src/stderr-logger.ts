/**
 * Structured Stderr Logger
 *
 * Minimal structured JSON logger for packages that cannot import createLogger
 * due to circular dependencies (shared-encryption → compiler → database → shared-encryption).
 *
 * Emits one JSON line per log entry to stderr for container log aggregators.
 */

export interface StderrLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

function emit(level: string, component: string, msg: string, meta?: Record<string, unknown>): void {
  const entry = {
    level,
    component,
    msg,
    time: new Date().toISOString(),
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export function createStderrLogger(component: string): StderrLogger {
  return {
    warn: (msg, meta) => emit('warn', component, msg, meta),
    info: (msg, meta) => emit('info', component, msg, meta),
    debug: () => {}, // no-op — debug is noisy in production
  };
}

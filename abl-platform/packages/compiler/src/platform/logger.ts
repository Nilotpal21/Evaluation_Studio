/**
 * Structured Logger — thin re-export from shared-observability
 *
 * All logger functionality is now centralized in @agent-platform/shared-observability.
 * This module re-exports the public API so that existing `import { createLogger } from '../logger.js'`
 * call sites within the compiler continue to work without modification.
 */

export {
  createLogger,
  setLogLevel,
  setLogHandler,
  redactSensitive,
} from '@agent-platform/shared-observability';
export type { Logger, LogLevel, LogEntry } from '@agent-platform/shared-observability';

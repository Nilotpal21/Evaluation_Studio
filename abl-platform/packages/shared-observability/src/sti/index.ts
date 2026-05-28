/**
 * STI — Structured Trace Identifiers
 *
 * A controlled vocabulary of trace paths and utilities for
 * config hashing, spatial trace recording, and path validation.
 */

export {
  STI_PATHS,
  type STIPath,
  isValidSTIPath,
  assertSTIPath,
  pathDepth,
  pathStartsWith,
} from './taxonomy.js';

export { computeConfigHash } from './config-hash.js';

export {
  STRBuffer,
  type STREntry,
  type EntryHandle,
  MAX_ENTRIES_PER_TRACE,
  TRACE_TTL_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_RESET_MS,
} from './str-buffer.js';

export { tracePath, setSharedSTRBuffer, getSharedSTRBuffer } from './trace-path.js';

export {
  STRWriter,
  type SpatialTraceRow,
  type RowWriter,
  type FlushContext,
  type FlushCallbacks,
} from './str-writer.js';

export { getVersionVector, resetVersionVector, type VersionVector } from './version-vector.js';

/**
 * Pipeline — Barrel Export
 *
 * Shared pipeline modules for all realtime channel handlers.
 * Import from `channels/pipeline` to access session creation,
 * message execution + persistence, and lifecycle cleanup.
 */

export {
  createRuntimeSession,
  createAndLinkDBSession,
  resolveEnvironmentLabel,
} from './session-factory.js';

export {
  createTraceAccumulator,
  accumulateTraceEvent,
  executeAndPersist,
} from './message-pipeline.js';

export { handleDisconnect } from './lifecycle-manager.js';

export type {
  SessionCreationContext,
  SessionCreationResult,
  DBSessionCreationContext,
  DBSessionResult,
  TraceAccumulator,
  PersistenceContext,
  ExecuteAndPersistOptions,
  ExecuteAndPersistResult,
  DisconnectContext,
} from './types.js';

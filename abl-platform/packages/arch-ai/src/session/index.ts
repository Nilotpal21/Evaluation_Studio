export { SessionService } from './session-service.js';
export { buildResumeSummary } from './resume-summary.js';
export type { ResumeSummary } from './resume-summary.js';
export { buildResumeSnapshot, evaluateQualityFloorIssues } from './resume-snapshot.js';
export { FileStoreService, createFileStoreService } from './file-store-service.js';
export type {
  SessionContext,
  ArchFileStore,
  SessionFileRecord,
  ResolvedImageSource,
  FileRecordStatus,
} from './file-store-service.js';
export {
  formatProjectSummary,
  redactCredentialUrls,
  MAX_SUMMARY_CHARS,
} from './project-summary.js';
export type { ProjectSummaryInput } from './project-summary.js';
export { createCheckpoint, addCheckpoint, rollbackFromCheckpoint } from './checkpoint-service.js';
export { ProjectMemoryService } from './project-memory-service.js';
export type { ProjectMemoryEntry, AddMemoryParams } from './project-memory-service.js';
export { LearningMemoryService } from './learning-memory-service.js';
export type {
  LearningEntry,
  LearningContext,
  RecordErrorFixParams,
  RecordTopologyChoiceParams,
  RecordConstructUsageParams,
} from './learning-memory-service.js';

// Seeded session infrastructure
export {
  sessionEventsChannel,
  publishFanOut,
  publishTurnEvent,
  publishSessionSignal,
  subscribeFanOut,
} from './fan-out-publisher.js';
export type { FanOutEnvelope, SessionSignal, TurnEvent } from '../types/turn-events.js';

export { createRingBuffer } from './ring-buffer.js';
export type {
  RingBufferEvent,
  RingBufferClient,
  RingBufferConfig,
  RingBuffer,
} from './ring-buffer.js';

export { buildDurablePublisher, DURABLE_EVENT_KINDS } from './publisher-factory.js';
export type { BuildDurablePublisherOpts, PublishableEvent } from './publisher-factory.js';

export {
  acquireTurnLock,
  renewTurnLock,
  releaseTurnLock,
  startRenewalLoop,
  writeAbortIntent,
  readAbortIntent,
  clearAbortIntent,
} from './session-lock.js';
export type { AcquireResult, LockValue } from './session-lock.js';

export { startSessionReconciler } from './session-reconciler.js';
export type {
  ReconcilerSessionDoc,
  ReconcilerOptions,
  ReconcilerHandle,
} from './session-reconciler.js';

export { createSessionStore } from './session-store.js';
export type { SessionStoreContext, SessionStoreOptions, SessionStore } from './session-store.js';

// ─── Session V2 constants ─────────────────────────────────────────────────
export { SCHEMA_VERSION_V2 } from '../types/session-v2.js';
export type {
  ArchSessionV2,
  StoredMessageV2,
  PendingInteractiveV2,
  PendingMutationV2,
  QueuedMessage,
  ActiveTurnLock,
  BuildProgressV2,
  StreamedPresentation,
  SessionStateV2,
} from '../types/session-v2.js';

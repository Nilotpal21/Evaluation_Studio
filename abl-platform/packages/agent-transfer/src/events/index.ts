export {
  type AgentDesktopEventType,
  type AgentDesktopEventJob,
  type SdkNotificationJob,
  type DurableEventConfig,
  DEFAULT_EVENT_CONFIG,
} from './types.js';
export { DurableEventQueue, type QueueHandle } from './durable-event-queue.js';
export {
  EventWorker,
  type EventProcessor,
  type DeadLetterHandler,
  type WorkerHandle,
  type EventWorkerConfig,
} from './event-worker.js';
export { SdkNotificationQueue, type SdkQueueHandle } from './sdk-notification-queue.js';
export {
  SessionTimeoutScheduler,
  type TimeoutQueueHandle,
  type TimeoutJob,
  type TimeoutHandler,
} from './session-timeout-scheduler.js';
export { registerTransferShutdownHandlers, type ShutdownComponents } from './graceful-shutdown.js';

/** Alias for ShutdownComponents — includes all closeable transfer components */
export type { ShutdownComponents as AgentTransferShutdownComponents } from './graceful-shutdown.js';
export {
  DeadLetterStore,
  type DeadLetterEntry,
  type DeadLetterStoreHandle,
} from './dead-letter-store.js';

// @agent-platform/a2a — Platform A2A adapter
// Wraps @a2a-js/sdk with platform concerns (tracing, tenant isolation, SSRF)

// --- Use cases ---
export { sendTask } from './application/send-task.js';
export type { SendTaskParams, SendTaskDeps } from './application/send-task.js';
export { discoverAgent } from './application/discover-agent.js';
export type { DiscoverAgentParams, DiscoverAgentDeps } from './application/discover-agent.js';

// --- Express server factory ---
export { createA2AExpressHandlers } from './infrastructure/express-handlers.js';
export type { CreateA2AExpressHandlersConfig } from './infrastructure/express-handlers.js';

// --- Infrastructure adapters (for advanced wiring) ---
export { AgentExecutorAdapter } from './infrastructure/agent-executor-adapter.js';
export type {
  AgentExecutorAdapterConfig,
  A2AAttachment,
  A2AAttachmentIngestor,
  A2AAttachmentIngestRequest,
} from './infrastructure/agent-executor-adapter.js';
export { SsrfEndpointValidator } from './infrastructure/ssrf-interceptor.js';
export { TracedCallInterceptor } from './infrastructure/traced-client.js';
export { LazyTaskStore } from './infrastructure/lazy-task-store.js';
export { AgentCardCache } from './infrastructure/agent-card-cache.js';

// --- Domain ports (for runtime to implement/inject) ---
export type {
  A2ATracingPort,
  EndpointValidator,
  AgentExecutionPort,
  ExecutionResult,
  SessionDetail,
  A2ASessionResolverPort,
  ResolvedA2ASession,
  A2ARequestContext,
} from './domain/ports.js';

// --- Session resolvers ---
export { MemoryA2ASessionResolver } from './infrastructure/memory-a2a-session-resolver.js';
export { RedisA2ASessionResolver } from './infrastructure/redis-a2a-session-resolver.js';

// --- SDK client factory (so consumers never import @a2a-js/sdk directly) ---
export { createA2AClient, createA2AClientWithAuth } from './infrastructure/client-factory.js';
export type { OutboundAuthConfig } from './infrastructure/authenticated-client-factory.js';

// --- Async A2A support ---
export { sendTaskAsync, SyncResponseForAsyncRequest } from './application/send-task-async.js';
export type { SendTaskAsyncParams, SendTaskAsyncDeps } from './application/send-task-async.js';

// --- Outbound streaming ---
export { sendTaskStreaming } from './application/send-task-streaming.js';
export type {
  SendTaskStreamingParams,
  SendTaskStreamingDeps,
  A2AStreamEvent,
} from './application/send-task-streaming.js';

// --- Task polling & cancel ---
export { pollTask } from './application/poll-task.js';
export type { PollTaskParams, PollTaskDeps } from './application/poll-task.js';
export { cancelRemoteTask } from './application/cancel-task.js';
export type { CancelTaskParams, CancelTaskDeps } from './application/cancel-task.js';

export { PushNotificationDeliveryService } from './application/push-notification-delivery.js';
export type { PushNotificationConfig } from './application/push-notification-delivery.js';

export { RedisA2ATaskStore } from './infrastructure/redis-task-store.js';
export type {
  A2ARedisClient,
  ListTasksParams,
  ListTasksResult,
} from './infrastructure/redis-task-store.js';

export { createA2ACallbackRouter } from './infrastructure/a2a-callback-handler.js';
export type { A2ACallbackDeps } from './infrastructure/a2a-callback-handler.js';

// --- Re-export SDK types consumers need ---
export type {
  Task,
  AgentCard,
  Message,
  Part,
  TextPart,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';

export { AGENT_CARD_PATH } from '@a2a-js/sdk';

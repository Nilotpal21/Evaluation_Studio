/**
 * @agent-platform/agent-transfer
 *
 * Agent-to-human transfer SDK for ABL Platform.
 * Provides adapters, session management, and transfer tools
 * for handing off conversations from AI agents to human agents.
 */

// Config
export {
  AgentTransferConfigSchema,
  TransferSessionConfigSchema,
  SmartAssistConfigSchema,
  ProviderConfigSchema,
  VoiceGatewayConfigSchema,
  RateLimitConfigSchema,
  KoreProviderConfigSchema,
  GenericProviderConfigSchema,
  Five9ProviderConfigSchema,
  ProjectAgentTransferConnectionRefSchema,
  ProjectAgentTransferDefaultRoutingSchema,
  ProjectAgentTransferSessionSchema,
  ProjectAgentTransferVoiceSchema,
  ProjectAgentTransferPiiSchema,
  ProjectAgentTransferSettingsSchema,
  resolveProjectAgentTransferConnectionRef,
  normalizeProjectAgentTransferSettings,
  type AgentTransferConfig,
  type TransferSessionConfig,
  type SmartAssistConfig,
  type ProviderConfig,
  type VoiceGatewayConfig,
  type RateLimitConfig,
  type KoreProviderConfig,
  type GenericProviderConfig,
  type Five9ProviderConfig,
  type ProjectAgentTransferConnectionRef,
  type ProjectAgentTransferDefaultRouting,
  type ProjectAgentTransferSettings,
  SMARTASSIST_DEFAULTS,
  PROVIDER_DEFAULTS,
  REDIS_KEY_PREFIXES,
} from './config/index.js';

// Types
export type {
  TransferChannel,
  TransferPayload,
  TransferContact,
  TransferRoutingVoiceContext,
  TransferRoutingContext,
  TransferIdentityHints,
  TransferContextSnapshot,
  VoiceCallData,
  TransferResult,
  TransferStatus,
  UserMessage,
  MessageAttachment,
  ConversationMessage,
  AgentEvent,
  AgentEventType,
  AgentMessageHandler,
  SessionEventHandler,
  AuthCredentials,
  AuthType,
  OperationResult,
  VoiceMessagePayload,
  VoiceTransferStatus,
  OOBFlags,
  VoiceToolResult,
  VoiceToolGatherResult,
  VoiceToolTransferResult,
  VoiceToolDeflectResult,
  VoiceToolHangupResult,
} from './types.js';
export {
  normalizeTransferChannel,
  resolveTransferOwnerId,
  resolveTransferSessionOwnerId,
  buildTransferRoutingContext,
  buildTransferContextSnapshot,
} from './types.js';

// Adapters
export {
  type AgentDesktopAdapter,
  type AdapterCapabilities,
  AdapterRegistry,
  type AuthProvider,
  InternalKeyAuth,
  OAuth2ClientAuth,
  JWTAuth,
  BasicAuth,
  BearerTokenAuth,
  OIDCAuth,
  SessionHeaderAuth,
} from './adapters/index.js';

// Kore adapter
export { KoreAdapter, type TransferSessionStoreHandle } from './adapters/kore/index.js';
export {
  SmartAssistClient,
  type CircuitBreakerHandle,
} from './adapters/kore/smartassist-client.js';
export { KoreEventHandler, type XOEvent } from './adapters/kore/event-handler.js';

// Five9 adapter
export { Five9Adapter } from './adapters/five9/index.js';
export { Five9EventHandler } from './adapters/five9/five9-event-handler.js';
export type {
  Five9Credentials,
  Five9AuthResult,
  Five9WebhookPayload,
  Five9MetadataResponse,
  Five9ConversationResponse,
  Five9AuthResponse,
} from './adapters/five9/types.js';

// Session
export {
  TransferSessionStore,
  SessionRecoveryService,
  type SessionRecoveryConfig,
  type RecoveryStats,
  type TransferSessionData,
  type TransferSessionState,
  type VoiceTransferData,
  type CreateTransferSessionInput,
  type UpdateTransferSessionFields,
  type CreateSessionResult,
  type ClaimSessionResult,
  CHANNEL_TTL_DEFAULTS,
  ACTIVE_SESSIONS_SET,
  RECOVERY_LEADER_KEY,
  sessionKey,
  providerIndexKey,
  podSessionsKey,
  podHeartbeatKey,
  LUA_CREATE_SESSION,
  LUA_END_SESSION,
  LUA_CLAIM_SESSION,
} from './session/index.js';

// Tools
export {
  TransferToAgentTool,
  TransferToAgentInputSchema,
  type TransferToAgentInput,
  type TransferToolContext,
  type TransferToolResult,
  CheckHoursTool,
  CheckHoursInputSchema,
  type CheckHoursInput,
  CheckAvailabilityTool,
  CheckAvailabilityInputSchema,
  type CheckAvailabilityInput,
  SetQueueTool,
  SetQueueInputSchema,
  type SetQueueInput,
  IVRMenuTool,
  IVRMenuInputSchema,
  type IVRMenuInput,
  type IVRMenuResult,
  type IVRMenuBranch,
  IVRDigitInputTool,
  IVRDigitInputSchema,
  type IVRDigitInput,
  type IVRDigitResult,
  type IVRDigitBranch,
  CallTransferTool,
  CallTransferInputSchema,
  type CallTransferInput,
  type CallTransferResult,
  DeflectToChatTool,
  DeflectToChatInputSchema,
  type DeflectToChatInput,
  type DeflectToChatResult,
  type DeflectBranch,
} from './tools/index.js';

// Voice
export {
  buildVoicePayload,
  isVoiceChannel,
  VOICE_CHANNELS,
  VOICE_EVENT_TYPES,
  type VoiceGatewaySession,
  type VoiceGateway,
  type DialAgentOptions,
  type PlayMessageOptions,
  type GatherDTMFOptions,
  VoiceGatewayRegistry,
  getVoiceGatewayRegistry,
} from './voice/index.js';

// Security
export { assertAllowedUrl } from './security/index.js';
export {
  checkRateLimit,
  type RateLimitConfig as RateLimitCheckConfig,
  type RateLimitResult,
} from './security/index.js';
export { redact, REDACT_FIELDS } from './security/index.js';
export {
  verifyWebhookSignature,
  createRedisNonceStore,
  type WebhookVerificationConfig,
  type WebhookVerificationResult,
  type WebhookNonceStore,
} from './security/index.js';
export {
  type SessionFieldEncryptor,
  TenantScopedSessionEncryptor,
  NullSessionEncryptor,
} from './security/index.js';

// Events
export {
  type AgentDesktopEventType,
  type AgentDesktopEventJob,
  type SdkNotificationJob,
  type DurableEventConfig,
  DEFAULT_EVENT_CONFIG,
  DurableEventQueue,
  type QueueHandle,
  EventWorker,
  type EventProcessor,
  type DeadLetterHandler,
  type WorkerHandle,
  type EventWorkerConfig,
  SdkNotificationQueue,
  type SdkQueueHandle,
  registerTransferShutdownHandlers,
  type ShutdownComponents,
  type AgentTransferShutdownComponents,
  DeadLetterStore,
  type DeadLetterEntry,
  type DeadLetterStoreHandle,
  SessionTimeoutScheduler,
  type TimeoutJob,
} from './events/index.js';

// Post-Agent
export {
  type PostAgentConfig,
  type CsatEventType,
  type CsatSessionEvent,
  type CsatEventHandler,
  CsatHandler,
  type SessionStoreHandle,
  DispositionHandler,
  type DeferredContext,
  type DispositionData,
} from './post-agent/index.js';

// History Formatter
export {
  type HistoryEntry,
  type HistoryFormatOptions,
  type HistoryDeliveryStrategy,
  KoreHistoryStrategy,
  GenericHistoryStrategy,
  getHistoryStrategy,
} from './adapters/history-formatter.js';

// Fallback Executor
export {
  type FallbackAdapter,
  executeWithFallback,
  getFallbackMetrics,
  resetFallbackMetrics,
} from './adapters/fallback-executor.js';

// Observability
export { createTransferLogger, type TransferLogContext } from './observability/transfer-logger.js';
export {
  type TraceEventEmitter,
  type TransferTraceEvent,
  type TransferInitiatedTrace,
  type TransferCompletedTrace,
  type TransferFailedTrace,
  type AgentConnectedTrace,
  type AgentDisconnectedTrace,
  type CsatCompletedTrace,
  emitTransferTraceEvent,
} from './observability/trace-events.js';
export {
  createTraceStoreAdapter,
  type TraceStoreHandle,
} from './observability/trace-store-adapter.js';

// Config Reloader
export {
  AgentTransferConfigReloader,
  type RedisSubscriber,
  type RedisPublisher,
  type ConfigReloadCallback,
} from './config/config-reloader.js';

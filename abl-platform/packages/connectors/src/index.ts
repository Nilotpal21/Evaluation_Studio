/**
 * @agent-platform/connectors
 *
 * Connector SDK for the ABL Platform.
 * Provides types, property builders, registry, and executor for
 * integrating external services (Slack, Stripe, Salesforce, etc.).
 */

// Core types
export type {
  Connector,
  ConnectorAction,
  ConnectorTrigger,
  ConnectorTriggerType,
  ConnectorAuth,
  ConnectorAuthType,
  ConnectorAuthField,
  ConnectorAuthValidator,
  ConnectorProperty,
  ConnectorPropertyType,
  DropdownOption,
  ActionContext,
  TriggerContext,
  TriggerRunContext,
  WebhookVerifyContext,
  KeyValueStore,
  CallbackContext,
  AsyncParkingSentinel,
  AzureDocumentIntelligenceServices,
} from './types.js';

// Async-parking sentinel guard — used by the workflow-engine step dispatcher
// to recognize when a connector action wants to suspend on a Restate promise.
export { isAsyncParkingSentinel } from './types.js';

// Native Docling connector + the canonical extraction envelope shape consumed
// by both the workflow-path worker (search-ai side) and downstream agent/UI
// nodes. The Azure Document Intelligence piece (Phase 3) emits the same
// envelope so workflow authors can swap providers without rewiring.
export {
  doclingConnector,
  runExtractDocument,
  DoclingActionError,
  normalizeDoclingToEnvelope,
  type DoclingNativeResponse,
  type NormalizeOptions,
  getDoclingRateLimiter,
  resetDoclingRateLimiter,
  DOCLING_RATE_LIMIT_KEY_PREFIX,
  DOCLING_RATE_LIMIT_WINDOW_SECONDS,
  type DoclingRedisClient,
} from './native/docling/index.js';
export {
  ExtractionEnvelopeSchema,
  ExtractionPageSchema,
  ExtractionTableSchema,
  ExtractionImageSchema,
  ExtractionHeadingSchema,
  ExtractionEnvelopeMetadataSchema,
  type ExtractionEnvelope,
  type ExtractionPage,
  type ExtractionTable,
  type ExtractionImage,
  type ExtractionHeading,
  type ExtractionEnvelopeMetadata,
} from './native/extraction-envelope.js';

export {
  normalizeAzureAnalyzeResult,
  type AzureAnalyzeResult,
  type AzureAnalyzePage,
  type AzureAnalyzeTable,
  type AzureNormalizeOptions,
} from '@abl/piece-azure-document-intelligence/normalize';

// Activepieces auth normalization — used by validate routes and other
// callers that need to map auth-profile secrets into the shape pieces expect.
// `normalizeAuthForAP` produces the action-runtime shape; the
// `normalizeAuthForPieceValidate` sibling produces the shape that piece-level
// `auth.validate` hooks expect (these can differ — see Shopify / Linear).
export {
  normalizeAuthForAP,
  normalizeAuthForPieceValidate,
  coerceParams,
  nestDotParams,
  coerceParamsByProps,
} from './adapters/activepieces/context-translator.js';

// Property builder
export { Property } from './properties.js';

// Registry
export { ConnectorRegistry } from './registry.js';

// Executor
export { ConnectorToolExecutor, type ExecutorContext } from './executor/index.js';
export {
  WorkflowToolExecutor,
  type WorkflowBinding,
  type WorkflowResult,
  type WorkflowClient,
  type WorkflowHandle,
  type WorkflowSubmitInput,
  type WorkflowToolExecutorContext,
} from './executor/index.js';

// Auth
export {
  ConnectionResolver,
  type AuthProfileResolverLike,
  type ConnectorConnectionModel,
  type OAuthGrantResolver,
  type ResolveOptions,
  type ResolvedConnection,
  getProviderConfig,
  registerProvider,
  listProviders,
} from './auth/index.js';

// Connection Service
export {
  ConnectionService,
  type ConnectionServiceDeps,
  type ConnectionRecord,
  type CreateConnectionInput,
  type UpdateConnectionInput,
  type TestResult,
  ConnectionServiceError,
} from './services/connection-service.js';

// Compiler bridge
export {
  connectorActionToToolDefinition,
  propsToJsonSchema,
  type ConnectorToolDefinition,
} from './compiler/connector-to-tool.js';

// Connector loader
export { loadConnectors } from './loader.js';

// Logger
export { createLogger } from './logger.js';
export type { Logger } from './logger.js';

// Triggers
export {
  TriggerEngine,
  handleWebhook,
  processPollingJob,
  TRIGGER_TYPES,
  REGISTRATION_TRIGGER_TYPES,
  WEBHOOK_MODES,
  WEBHOOK_DELIVERIES,
} from './triggers/index.js';
export type {
  PollingSchedulerDeps,
  PollingAuthResolver,
  WorkflowDefinitionResolver,
  TriggerRegistration,
  TriggerRegistrationModel,
  TriggerRedisClient,
  RestateIngressClient,
  WorkflowTriggerInput,
  TriggerQueue,
  TriggerJobData,
  DecryptSecretFn,
  WebhookRequest,
  WebhookResult,
  WebhookHandlerDeps,
  RegistrationTriggerType,
  TriggerType,
  WebhookMode,
  WebhookDelivery,
} from './triggers/index.js';

/**
 * Platform Stores Index
 *
 * MongoDB and ClickHouse implementations of the compiler's abstract store patterns.
 *
 * These implementations provide:
 * - DB persistence for sessions (MongoDB)
 * - DB persistence for messages (MongoDB / ClickHouse)
 * - DB persistence for LLM usage metrics (MongoDB / ClickHouse)
 * - Agent version control and promotion workflow
 * - Store factory for store selection
 */

// Mongo store implementations
export {
  MongoConversationStore,
  createMongoConversationStore,
} from './mongo-conversation-store.js';

export { MongoMessageStore, createMongoMessageStore } from './mongo-message-store.js';

export { MongoAgentRegistry, createMongoAgentRegistry } from './mongo-agent-registry.js';

export { MongoContactStore, createMongoContactStore } from './mongo-contact-store.js';

export {
  MongoWorkflowDefinitionStore,
  createMongoWorkflowDefinitionStore,
} from './mongo-workflow-definition-store.js';

export { MongoFactStore, createMongoFactStore } from './mongo-fact-store.js';

export {
  MongoDBFactStore,
  PROJECT_SCOPE_USER_ID,
  ReservedPrefixError,
  createMongoDBFactStore,
  createProjectFactStore,
} from './mongodb-fact-store.js';
export type { SetInternalOptions } from './mongodb-fact-store.js';

export { FactStoreWorkflowAdapter } from './fact-store-workflow-adapter.js';
export type { SetWorkflowKeyOptions } from './fact-store-workflow-adapter.js';

export {
  MAX_FACT_TTL_MS,
  MAX_VALUE_SIZE_BYTES,
  MAX_KEY_LENGTH,
  MAX_WRITES_PER_RUN,
  RESERVED_KEY_PREFIXES,
  WORKFLOW_KEY_PREFIX,
  buildWorkflowKey,
  startsWithReservedPrefix,
} from './workflow-memory-constants.js';

// Store factory
export { getStores } from './store-factory.js';

// Re-export compiler store interfaces for convenience
export type {
  ConversationStore,
  ConversationStoreConfig,
  CreateSessionParams,
  AddMessageParams,
  ResumeSessionParams,
  QuerySessionsParams,
  QueryMessagesParams,
} from '@abl/compiler/platform/stores/conversation-store.js';

export type {
  MessageStore,
  MessageStoreConfig,
} from '@abl/compiler/platform/stores/message-store.js';

export type {
  MetricsStore,
  MetricsStoreConfig,
  LLMMetricInput,
  MetricsQueryParams,
  TenantMetricsQueryParams,
  UsageSummary,
  CostBreakdown,
  DailyUsage,
  ProjectUsage,
} from '@abl/compiler/platform/stores/metrics-store.js';

export type {
  AgentRegistry,
  AgentRegistryConfig,
  RegisterAgentParams,
  PromoteAgentParams,
  RollbackAgentParams,
  QueryAgentsParams,
  ActiveVersions,
} from '@abl/compiler/platform/stores/agent-registry.js';

export type {
  ContactStore,
  ContactStoreConfig,
  CreateContactParams,
  UpdateContactParams,
  QueryContactsParams,
} from '@abl/compiler/platform/stores/contact-store.js';

export type {
  WorkflowDefinitionStore,
  WorkflowDefinitionStoreConfig,
  CreateWorkflowDefinitionParams,
  UpdateWorkflowDefinitionParams,
  QueryWorkflowDefinitionsParams,
} from '@abl/compiler/platform/stores/workflow-definition-store.js';

export type {
  FactStore,
  FactStoreConfig,
  Fact,
  SetFactParams,
  GetFactParams,
  QueryFactsParams,
  BatchSetParams,
} from '@abl/compiler/platform/stores/fact-store.js';

export type {
  AuditStore,
  AuditStoreConfig,
  AlertConfig,
  LogAuditParams,
  QueryAuditParams,
  AuditSummary,
} from '@abl/compiler/platform/stores/audit-store.js';

// ClickHouse store implementations
export { ClickHouseMessageStore } from './clickhouse-message-store.js';
export type { ClickHouseMessageStoreOptions } from './clickhouse-message-store.js';

export { ClickHouseMetricsStore } from './clickhouse-metrics-store.js';
export type { ClickHouseMetricsStoreOptions } from './clickhouse-metrics-store.js';

export { ClickHouseAuditStore } from './clickhouse-audit-store.js';
export type { ClickHouseAuditStoreOptions } from './clickhouse-audit-store.js';

export { ClickHouseFactStore, createClickHouseFactStore } from './clickhouse-fact-store.js';
export type { ClickHouseFactStoreOptions } from './clickhouse-fact-store.js';

export { createClickHouseStoreFactory } from './clickhouse-store-factory.js';
export type {
  ClickHouseStoreFactory,
  ClickHouseStoreFactoryOptions,
} from './clickhouse-store-factory.js';

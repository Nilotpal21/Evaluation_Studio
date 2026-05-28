/**
 * Platform Core Types
 *
 * Shared types used across all platform components.
 */

// =============================================================================
// CONTACTS
// =============================================================================

export type ContactType = 'employee' | 'customer' | 'anonymous';

export type IdentityType = 'email' | 'phone' | 'external';

export interface Contact {
  id: string;
  tenantId: string;
  type: ContactType;
  identity?: string;
  identityType?: IdentityType;
  displayName?: string;
  department?: string;
  employeeId?: string;
  company?: string;
  accountRef?: string;
  channel?: string;
  metadata: Record<string, unknown>;
  tags: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  deletedAt?: Date;
}

// =============================================================================
// WORKFLOW DEFINITIONS
// =============================================================================

export type WorkflowDefinitionType = 'cx_automation' | 'ex_automation' | 'internal';

export type WorkflowDefinitionStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface WorkflowDefinition {
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  type: WorkflowDefinitionType;
  description?: string;
  entryAgent?: string;
  steps: Record<string, unknown>[];
  triggers: Record<string, unknown>[];
  slaMinutes?: number;
  escalationRules: Record<string, unknown>[];
  notificationRules?: Record<string, unknown>[];
  status: WorkflowDefinitionStatus;
  metadata: Record<string, unknown>;
  tags?: string[];
  // Node-based canvas fields
  nodes?: Record<string, unknown>[];
  edges?: Record<string, unknown>[];
  envVars?: Record<string, string>;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  createdAt: Date;
  archivedAt?: Date;
  updatedAt?: Date;
}

// =============================================================================
// CHANNELS & SESSIONS
// =============================================================================

export type Channel =
  | 'voice'
  | 'web_chat'
  | 'web_debug'
  | 'whatsapp'
  | 'sms'
  | 'email'
  | 'api'
  | 'http_async';

export type SessionStatus = 'active' | 'idle' | 'completed' | 'abandoned' | 'escalated';

export type CallDisposition =
  | 'completed' // Normal completion
  | 'abandoned' // User hung up
  | 'agent_hangup' // Agent disconnected
  | 'transferred' // Transferred to human
  | 'failed' // System failure
  | 'timeout'; // Session timeout

export type CanonicalSessionDisposition = CallDisposition | 'unengaged';

export type CanonicalSessionStatus = 'completed' | 'escalated' | 'abandoned';

export type SessionDisconnectBehavior = 'end' | 'detach';

export type SessionTerminalSource =
  | 'close_api'
  | 'bulk_close'
  | 'cleanup'
  | 'disconnect'
  | 'sdk_end_session'
  | 'transfer_end'
  | 'provider_end';

export type SessionEndHookConfig = { mode: 'ignore' } | { mode: 'respond'; message: string };

export interface SessionDisconnectConfig {
  defaultDisposition?: CanonicalSessionDisposition;
  disconnectBehavior?: SessionDisconnectBehavior;
}

export interface SessionLifecycleRuntimeConfig {
  idleSeconds?: number;
  maxAgeSeconds?: number;
}

export interface AgentSessionLifecycleConfig extends SessionLifecycleRuntimeConfig {
  disconnect?: SessionDisconnectConfig;
}

export interface ProjectSessionLifecycleChannelConfig extends SessionDisconnectConfig {
  endHook?: SessionEndHookConfig;
}

export interface ProjectSessionLifecycleConfig {
  runtime?: SessionLifecycleRuntimeConfig;
  endHook?: SessionEndHookConfig;
  channels?: Partial<Record<Channel, ProjectSessionLifecycleChannelConfig>>;
}

export type StudioSessionSource = {
  type: 'studio';
  workspaceUserId?: string | null;
};

export type PublicSessionSource = {
  type: 'public';
  endUserId?: string | null;
  contactId?: string | null;
};

export type ChannelSessionSource = {
  type: 'channel';
  channelId?: string | null;
  endUserId?: string | null;
  contactId?: string | null;
};

export type SessionSource = StudioSessionSource | PublicSessionSource | ChannelSessionSource;

/**
 * Known session purpose — orthogonal to SessionSource (which captures WHERE
 * traffic entered). `knownSource` captures WHY the session exists.
 *
 * - `production` — real end-user traffic (default when absent)
 * - `eval`       — created by the pipeline-engine's eval runner
 * - `synthetic`  — created by a cost-estimator or load-test harness
 */
export type KnownSessionSource = 'production' | 'eval' | 'synthetic';

export interface Session {
  id: string;
  customerId?: string;
  anonymousId?: string;
  sessionPrincipalId?: string;
  channel: Channel;
  channelHistory: Channel[];
  status: SessionStatus;
  currentAgent: string;
  agentVersion: string;
  environment: Environment;
  context: Record<string, unknown>;
  startedAt: Date;
  lastActivityAt: Date;
  endedAt?: Date;
  disposition?: CallDisposition;
  metadata: SessionMetadata;
  // Expanded fields (absorbed from AgentSession + new)
  contactId?: string;
  callerNumber?: string;
  initiatedById?: string;
  projectId?: string;
  tenantId?: string;
  workflowId?: string;
  workflowStepId?: string;
  parentId?: string;
  callDuration?: number;
  dispositionCode?: string;
  archivedAt?: Date;
  // Deployment & billing (denormalized)
  deploymentId?: string;
  projectSlug?: string;
  entryAgentName?: string;
  region?: string;
  billingPeriod?: string;
  isTest?: boolean;
  messageCount?: number;
  tokenCount?: number;
  estimatedCost?: number;
  errorCount?: number;
  handoffCount?: number;
  tags?: string[];
  source?: SessionSource | null;
  /** Session purpose tag — orthogonal to `source` (front-door type).
   *  null/undefined is treated as 'production' by billing/analytics. */
  knownSource?: KnownSessionSource | null;
}

export interface SessionMetadata {
  /** Source of the session (campaign, referrer, etc.) */
  source?: string;
  /** Device/client info */
  clientInfo?: ClientInfo;
  /** Voice-specific metadata */
  voiceMetadata?: VoiceMetadata;
  /** Custom tags */
  tags?: string[];
}

export interface ClientInfo {
  userAgent?: string;
  platform?: string;
  /**
   * Legacy compatibility input only.
   * Runtime execution should resolve locale from canonical InteractionContext instead.
   */
  locale?: string;
  /**
   * Legacy compatibility input only.
   * Runtime execution should resolve timezone from canonical InteractionContext instead.
   */
  timezone?: string;
}

export interface VoiceMetadata {
  /** Phone number (from) */
  callerNumber?: string;
  /** Phone number (to) */
  calledNumber?: string;
  /** Call SID/ID from telephony provider */
  callSid?: string;
  /** Telephony provider (twilio, vonage, etc.) */
  provider?: string;
  /** Recording URL if available */
  recordingUrl?: string;
  /** Call duration in seconds */
  durationSeconds?: number;
}

// =============================================================================
// MESSAGES
// =============================================================================

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  channel: Channel;
  timestamp: Date;
  traceId: string;
  metadata: MessageMetadata;
}

export interface MessageMetadata {
  /** Token counts */
  tokens?: {
    input?: number;
    output?: number;
  };
  /** Latency in ms */
  latencyMs?: number;
  /** Model used */
  model?: string;
  /** Tool calls in this message */
  toolCalls?: ToolCallRecord[];
  /** If voice, transcript confidence */
  transcriptConfidence?: number;
  /** If voice, was this from ASR or TTS */
  voiceType?: 'asr' | 'tts';
  /**
   * Agent that produced this message. Surfaced as a first-class field so
   * feedback capture and per-agent analytics can attribute the row without
   * parsing free-form metadata.
   */
  agentName?: string;
  /** Custom metadata for application-specific data */
  custom?: Record<string, unknown>;
}

export interface ToolCallRecord {
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  latencyMs: number;
  success: boolean;
  error?: string;
}

// =============================================================================
// ENVIRONMENTS & VERSIONING
// =============================================================================

// Re-exported from @agent-platform/config as the single source of truth.
// Kept here for backward compatibility — all platform components import from this file.
import type { Environment as _Environment } from '@agent-platform/config';
export type Environment = _Environment;

export type AgentStatus = 'draft' | 'testing' | 'staged' | 'active' | 'deprecated' | 'archived';

export interface AgentVersion {
  agentName: string;
  version: string;
  status: AgentStatus;
  dslContent: string;
  irContent: string;
  sourceHash: string;
  createdAt: Date;
  createdBy: string;
  promotedAt?: Date;
  promotedBy?: string;
  changelog: string;
  testResults?: TestResults;
}

export interface TestResults {
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  testRuns: TestRun[];
}

export interface TestRun {
  testName: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

// =============================================================================
// TRACING
// =============================================================================

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sessionId: string;
  agentName: string;
  agentVersion: string;
  environment: Environment;
  startTime: Date;
  endTime?: Date;
  events: TraceEvent[];
  /** Pod/node identifier for distributed tracing */
  nodeId?: string;
}

import type {
  TraceEventType as _TraceEventType,
  TraceEvent as _TraceEvent,
} from '@agent-platform/shared-kernel';
export type TraceEventType = _TraceEventType;
export type TraceEvent = _TraceEvent;

export interface LLMCallEvent extends TraceEvent {
  type: 'llm_call';
  data: {
    model: string;
    messagesIn: number;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    cost?: number;
  };
}

export interface ToolCallEvent extends TraceEvent {
  type: 'tool_call';
  data: {
    toolName: string;
    input: Record<string, unknown>;
    output: unknown;
    success: boolean;
    latencyMs: number;
    error?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface DecisionEvent extends TraceEvent {
  type: 'decision';
  data: {
    decisionKind: 'routing' | 'escalation' | 'handoff' | 'constraint';
    /** @deprecated Backward-compat alias for decisionKind */
    kind?: string;
    decision: string;
    reasoning: string;
    contextSnapshot: Record<string, unknown>;
  };
}

// =============================================================================
// AUDIT
// =============================================================================

export type AuditEventType =
  // Agent lifecycle
  | 'agent.created'
  | 'agent.updated'
  | 'agent.promoted'
  | 'agent.rolled_back'
  | 'agent.deprecated'
  | 'agent.version_created'
  | 'agent.dsl_updated'
  // Tool events
  | 'tool.executed'
  | 'tool.created'
  | 'tool.updated'
  | 'tool.deleted'
  // Deployment events
  | 'deployment.status_changed'
  // Execution events
  | 'session.started'
  | 'session.ended'
  | 'handoff.executed'
  | 'escalation.triggered'
  | 'human.intervention'
  | 'human.completed'
  // Contact events
  | 'contact.created'
  | 'contact.updated'
  | 'contact.deleted'
  | 'contact.linked'
  // Workflow events
  | 'workflow.created'
  | 'workflow.updated'
  | 'workflow.archived'
  | 'workflow.deleted'
  | 'workflow.version_activated'
  | 'workflow.version_deactivated'
  | 'workflow.version_created'
  | 'workflow.version_deleted'
  // Session access/modification
  | 'session.accessed'
  | 'session.modified'
  | 'trace.queried'
  // Test context events
  | 'session.context_injected'
  | 'session.tool_mock_set'
  | 'session.test_created'
  // Security/compliance
  | 'pii.accessed'
  | 'permission.denied'
  | 'rate_limit.hit'
  // Prompt Library events
  | 'prompt.created'
  | 'prompt.version_created'
  | 'prompt.version_promoted'
  | 'prompt.version_archived'
  | 'prompt.tested';

export type AuditActorType = 'user' | 'admin' | 'agent' | 'system' | 'unknown';

export type AuditResourceType =
  | 'agent'
  | 'session'
  | 'customer'
  | 'contact'
  | 'workflow_definition'
  | 'workflow_version'
  | 'deployment'
  | 'tool'
  | 'prompt'
  | (string & {});

export type AuditMetadataEncoding = 'object' | 'json-string';

export type AuditRetentionClass = 'default' | 'auth' | 'crud' | 'indefinite';

export type AuditSource =
  | 'runtime-store'
  | 'runtime-auth'
  | 'studio'
  | 'admin'
  | 'search-ai'
  | 'mongoose-plugin';

export interface AuditLog {
  id: string;
  tenantId: string;
  projectId?: string;
  timestamp: Date;
  eventType: AuditEventType;
  actor: string;
  actorType: AuditActorType;
  resourceType: AuditResourceType;
  resourceId: string;
  environment: Environment;
  action: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  traceId?: string;
  schemaVersion?: number;
  source?: AuditSource;
  metadataEncoding?: AuditMetadataEncoding;
  retentionClass?: AuditRetentionClass;
  expiresAt?: Date | null;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface PlatformConfig {
  environment: Environment;
  llm: LLMConfig;
  runtimes: RuntimesConfig;
  storage: StorageConfig;
  observability: ObservabilityConfig;
  security: SecurityConfig;
}

export interface LLMConfig {
  defaultModel: string;
  voiceModel: string;
  fallbackModels: string[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  provider: 'openai' | 'anthropic' | 'azure' | 'bedrock' | 'litellm';
  apiKey?: string;
  baseUrl?: string;
}

export interface RuntimesConfig {
  voice: VoiceRuntimeConfig;
  digital: DigitalRuntimeConfig;
  workflow: WorkflowRuntimeConfig;
}

export interface VoiceRuntimeConfig {
  enabled: boolean;
  latencyTargetMs: number;
  toolTimeoutMs: number;
  maxConcurrentCalls: number;
  transcriptRetention: 'always' | 'on_success' | 'never';
}

export interface DigitalRuntimeConfig {
  enabled: boolean;
  sessionTimeoutMs: number;
  checkpointEnabled: boolean;
  checkpointStore: 'redis' | 'postgres' | 'memory';
}

export interface WorkflowRuntimeConfig {
  enabled: boolean;
  hitlEnabled: boolean;
  maxPendingTasks: number;
  taskTimeoutMs: number;
}

export interface StorageConfig {
  conversations: {
    type: 'postgres' | 'mongodb' | 'memory';
    connectionString?: string;
  };
  traces: {
    type: 'langfuse' | 'langsmith' | 'postgres' | 'clickhouse';
    connectionString?: string;
    apiKey?: string;
  };
  audit: {
    type: 's3' | 'postgres' | 'clickhouse';
    bucket?: string;
    connectionString?: string;
  };
  cache: {
    type: 'redis' | 'memory';
    connectionString?: string;
    ttlMs: number;
  };
}

export interface ObservabilityConfig {
  traceSamplingRate: number;
  metricsEnabled: boolean;
  loggingLevel: 'debug' | 'info' | 'warn' | 'error';
  alerting: {
    enabled: boolean;
    webhookUrl?: string;
  };
}

export interface SecurityConfig {
  piiDetection: boolean;
  piiRedaction: boolean;
  rateLimiting: {
    enabled: boolean;
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
}

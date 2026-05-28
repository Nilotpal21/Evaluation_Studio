import type { ActionSetIR, RichContentIR, VoiceConfigIR } from '@abl/compiler';
import type { PersistedStructuredMessageEnvelopeV2 } from '../session/persisted-message-content.js';

/**
 * Agent Assist V1 Compatibility Facade — shared types.
 *
 * Layer B of the feature in docs/features/agent-assist-runtime-compat.md.
 */

export type BindingStatus = 'active' | 'disabled';

/**
 * AgentAssistBinding — hydrated shape used inside the facade.
 * Persisted as a MongoDB document via `packages/database/src/models/agent-assist-binding.model.ts`.
 */
export interface AgentAssistBinding {
  /**
   * Stable binding identifier. Populated from Mongo `_id`. Used as the authoritative
   * correlation ID in trace events (never `apiKeyId`, which is the credential and may
   * be unset).
   */
  bindingId?: string;
  /** Kore.ai Agent Assist App ID (e.g. "aa-<uuid>"). Public-facing key. */
  appId: string;
  /** Environment name, normalized lowercase at resolve time. */
  environment: string;
  /** ABL tenant that owns this binding. */
  tenantId: string;
  /** ABL project that will execute the agent for this binding. */
  projectId: string;
  /** Optional pinned deployment; when omitted, environment-active deployment is resolved per request. */
  deploymentId?: string;
  /**
   * Opaque identifier of the ABL API key expected to be presented via `x-api-key`.
   * Used in `callerContext.apiKeyId` for session isolation (per FR-7 / FR-20).
   */
  apiKeyId?: string;
  /**
   * Optional per-binding runtime base URL override. Present on Mongo-backed bindings;
   * forwarded to the facade for future multi-region / tenant-specific routing. Empty
   * string and null are both coalesced to `undefined`.
   */
  runtimeBaseUrl?: string;
  /**
   * Binding mode:
   *   - "active":   facade invokes the real `RuntimeExecutor` for every turn.
   *   - "disabled": facade returns 404 APP_NOT_FOUND (existence-disclosure invariant — same envelope as a missing binding).
   */
  status: BindingStatus;
  /** Human-readable label for logs / operator tooling. */
  displayName?: string;
}

/** V1 session-identity tuple (shape Kore.ai Agent Assist sends today). */
export interface V1SessionIdentity {
  type: 'sessionReference' | 'sessionId' | 'sessionIdentity' | 'userReference';
  value: string;
}

/** V1 input content block. Currently only `text` is interpreted; other types are accepted for forward compat. */
export interface V1InputItem {
  type: 'text' | 'object' | 'tool_input';
  content: string | Record<string, unknown>;
}

/** V1 stream option. Only `tokens` mode is implemented today. */
export interface V1StreamOptions {
  enable?: boolean;
  streamMode?: 'tokens' | 'messages';
}

export interface V1DebugOptions {
  enable?: boolean;
  debugMode?: 'full' | 'thoughts';
}

export interface V1ExecuteRequest {
  sessionIdentity: V1SessionIdentity[];
  input: V1InputItem[];
  stream?: V1StreamOptions;
  debug?: V1DebugOptions;
  source?: string;
  metadata?: Record<string, unknown>;
  isAsync?: boolean;
  callbackUrl?: string;
  /** Accepted for forward-compat; not interpreted today. */
  invoke?: unknown;
  attachments?: unknown;
  additionalArgs?: unknown;
  metrics?: unknown;
}

/** V1 sync response envelope. */
export interface V1ExecuteResponse {
  messageId: string;
  output: V1OutputBlock[];
  sessionInfo: V1SessionInfo;
  metadata?: Record<string, unknown>;
  events?: unknown[];
  metrics?: unknown;
}

export interface V1OutputBlock {
  type: 'text';
  content: string;
  richContent?: RichContentIR;
  actions?: ActionSetIR;
  voiceConfig?: VoiceConfigIR;
  contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
}

export interface V1SessionInfo {
  sessionId: string;
  runId: string;
  status: 'processing' | 'completed' | 'error' | 'idle' | 'busy' | 'awaiting';
  sessionReference?: string;
  userReference?: string;
  userId?: string;
  appId: string;
  source?: string;
}

/** V1 SSE frame payload. Agent Assist parses each `data: <json>\n\n` packet as this shape. */
export interface V1StreamFrame {
  eventIndex: number;
  isLastEvent: boolean;
  messageId?: string;
  output?: V1OutputBlock[];
  sessionInfo?: V1SessionInfo;
  metadata?: Record<string, unknown>;
}

/**
 * V1 session envelope as documented at
 * https://docs.kore.ai/agent-platform/apis/agentic-apps/sessions
 * Returned by `POST /sessions`.
 */
export interface V1SessionObject {
  sessionId: string; // "s-<uuid>"
  sessionReference: string | null;
  userReference: string;
  status: 'idle' | 'busy' | 'error' | 'started';
  userId: string; // "u-<uuid>"
  createdAt: string; // ISO-8601
  source: string;
}

export type V1WelcomeEventType = 'Welcome_Event' | 'IDP_Redirect';

export interface V1SessionEvent {
  type: V1WelcomeEventType;
  content?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

export interface V1FileUploadConfig {
  maxFileCount: number;
  maxFileSize: number; // MB
  maxTokens: number;
  isAttachmentsEnabled: boolean;
}

export interface V1CreateSessionResponse {
  session: V1SessionObject;
  events: V1SessionEvent[];
  output: V1OutputBlock[];
  allowedMimeTypes: string[];
  fileUploadConfig: V1FileUploadConfig;
}

export interface V1TerminateSessionResponse {
  status: 'terminated';
  userReference: string;
  sessionReference: string;
  userId: string;
  sessionId: string;
  appId: string;
  attachments: Array<{ fileId: string; fileName: string; fileType: string }>;
}

/** Canonical message shape used internally between request translation and execution. */
export interface AgentAssistExecutionInput {
  /** The user / caller text ABL should treat as the current turn. */
  userMessage: string;
  /** Stable per-binding session key (tenantId + appId + environment + bindingRef + sessionReference). */
  sessionReference: string;
  /** Forwarded metadata, already normalized + reserved keys stripped. */
  messageMetadata?: Record<string, unknown>;
}

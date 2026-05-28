// packages/a2a/src/domain/ports.ts

import type {
  InteractionContextInput,
  ResponseMessageMetadata,
} from '@agent-platform/shared-kernel';

export type SessionDetailMessageMetadata = Record<string, unknown> &
  Partial<ResponseMessageMetadata>;

export interface A2ATracingPort {
  traceOutbound(params: {
    targetEndpoint: string;
    taskId: string;
    tenantId: string;
    durationMs: number;
    status: 'success' | 'error';
    error?: string;
  }): void;

  traceInbound(params: {
    sourceIp: string;
    taskId: string;
    tenantId: string;
    agentName: string;
    durationMs: number;
    status: 'success' | 'error';
    error?: string;
  }): void;
}

export interface EndpointValidator {
  validate(url: string, allowPrivate?: boolean): void;
}

export interface ExecutionResult {
  response: string;
  responseMetadata?: ResponseMessageMetadata;
  action?: { type: string; [key: string]: unknown };
  richContent?: {
    markdown?: string;
    adaptive_card?: string;
  };
  actions?: unknown;
}

export interface SessionDetail {
  messages: Array<{
    role: string;
    content: string;
    metadata?: SessionDetailMessageMetadata;
  }>;
}

// =============================================================================
// REQUEST CONTEXT
// =============================================================================

/** Per-request context resolved from ChannelConnection — no defaults, no fallbacks */
export interface A2ARequestContext {
  tenantId: string;
  projectId: string;
  connectionId: string;
  deploymentId?: string;
  environment?: string;
  /** Attachment IDs created from inbound file parts by the hosting runtime. */
  attachmentIds?: string[];
  /** Canonical per-turn interaction context extracted from the inbound A2A message. */
  interactionContext?: InteractionContextInput;
  /** Optional per-message metadata payload validated by the hosting runtime. */
  messageMetadata?: unknown;
  /** Integration-supplied session metadata → stored at session.data.values._metadata */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// SESSION RESOLUTION
// =============================================================================

export interface ResolvedA2ASession {
  sessionId: string;
  isNew: boolean;
}

/**
 * Maps A2A contextId to a platform RuntimeSession.
 * Follows the same pattern as channel session-resolver.ts.
 */
export interface A2ASessionResolverPort {
  resolveSession(contextId: string, tenantId: string): Promise<ResolvedA2ASession>;
  registerSession(contextId: string, tenantId: string, sessionId: string): Promise<void>;
  touchSession(contextId: string, tenantId: string): Promise<void>;
  closeSession(contextId: string, tenantId: string): Promise<void>;

  /**
   * Atomic register-if-absent: sets the mapping only if no mapping exists yet.
   * Returns the winning sessionId (may differ from the provided one if another
   * concurrent caller registered first). This eliminates the resolve→create→register
   * race where two concurrent first-turn requests fork into separate sessions.
   *
   * Implementations:
   * - Redis: `SET NX` + `GET` fallback
   * - Memory: synchronous Map check-and-set (single-threaded JS)
   *
   * Callers that lose the race should discard their newly-created session
   * and use the returned winner sessionId instead.
   */
  registerSessionIfAbsent?(
    contextId: string,
    tenantId: string,
    sessionId: string,
  ): Promise<{ sessionId: string; alreadyExisted: boolean }>;
}

// =============================================================================
// EXECUTION
// =============================================================================

export interface AgentExecutionPort {
  executeMessage(
    sessionId: string,
    message: string,
    context: A2ARequestContext,
  ): Promise<ExecutionResult>;

  /**
   * Streaming variant — calls onChunk with each text delta as the LLM generates tokens.
   * Optional for backward compatibility; callers check existence before using.
   */
  executeMessageStreaming?(
    sessionId: string,
    message: string,
    onChunk: (chunk: string) => void,
    onTraceEvent: ((event: { type: string; data: Record<string, unknown> }) => void) | undefined,
    context: A2ARequestContext,
  ): Promise<ExecutionResult>;

  getSessionDetail(sessionId: string): SessionDetail | null;

  createSession(context: A2ARequestContext): Promise<string>;
}

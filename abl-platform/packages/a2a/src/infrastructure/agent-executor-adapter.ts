// packages/a2a/src/infrastructure/agent-executor-adapter.ts

import { AsyncLocalStorage } from 'async_hooks';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type {
  Part,
  TextPart,
  Message,
  Task,
  TaskState,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';
import type {
  A2ATracingPort,
  AgentExecutionPort,
  A2ASessionResolverPort,
  A2ARequestContext,
  ExecutionResult,
} from '../domain/ports.js';
import { createLogger } from '@abl/compiler/platform';
import type { InteractionContextInput } from '@agent-platform/shared-kernel';

const log = createLogger('a2a:executor-adapter');

/**
 * AsyncLocalStorage for per-request A2ARequestContext.
 * Avoids mutable state on the shared adapter singleton — each concurrent
 * request gets its own context via the async continuation chain.
 */
export const a2aContextStorage = new AsyncLocalStorage<A2ARequestContext>();

export interface AgentExecutorAdapterConfig {
  /** Name of the local agent being served */
  agentName: string;
  /** Platform execution port (delegates to RuntimeExecutor) */
  executionPort: AgentExecutionPort;
  /** Tracing port for inbound call instrumentation */
  tracing: A2ATracingPort;
  /** Optional session resolver for contextId → RuntimeSession mapping */
  sessionResolver?: A2ASessionResolverPort;
  /**
   * Optional host-provided ingestor that converts inbound A2A file parts into
   * runtime attachment IDs before execution. This keeps the generic adapter
   * free of runtime-specific upload dependencies.
   */
  attachmentIngestor?: A2AAttachmentIngestor;
}

/** Attachment extracted from a file part. */
export interface A2AAttachment {
  uri?: string;
  bytes?: string;
  mimeType?: string;
  name?: string;
}

export interface A2AAttachmentIngestRequest {
  attachments: A2AAttachment[];
  sessionId: string;
  context: A2ARequestContext;
}

export type A2AAttachmentIngestor = (params: A2AAttachmentIngestRequest) => Promise<string[]>;

/** Result of extracting content from A2A message parts. */
interface ExtractedContent {
  text: string;
  attachments: A2AAttachment[];
}

interface StructuredResponsePayload {
  responseMetadata?: ExecutionResult['responseMetadata'];
  richContent?: ExecutionResult['richContent'];
  actions?: ExecutionResult['actions'];
}

/**
 * Extracts content from A2A message parts.
 * - TextParts: concatenated into a single text string
 * - DataParts: serialized as JSON and appended to text
 * - FileParts: collected as attachments for the execution port
 */
function extractContentFromParts(parts: Part[]): ExtractedContent {
  const textSegments: string[] = [];
  const attachments: A2AAttachment[] = [];

  for (const part of parts) {
    switch (part.kind) {
      case 'text':
        textSegments.push((part as TextPart).text);
        break;
      case 'data':
        textSegments.push(JSON.stringify((part as { data: unknown }).data));
        break;
      case 'file': {
        const filePart = part as {
          file: { uri?: string; bytes?: string; mimeType?: string; name?: string };
        };
        attachments.push({
          uri: filePart.file.uri,
          bytes: filePart.file.bytes,
          mimeType: filePart.file.mimeType,
          name: filePart.file.name,
        });
        break;
      }
    }
  }

  return { text: textSegments.join('\n'), attachments };
}

function extractInboundMessageMetadata(message: Message): unknown {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }

  // `history` stays reserved for cross-agent transcript forwarding.
  // Custom turn-scoped metadata travels under `message.metadata.messageMetadata`.
  return (metadata as Record<string, unknown>).messageMetadata;
}

export function extractInteractionContext(message: Message): InteractionContextInput | undefined {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }

  const raw = (metadata as Record<string, unknown>).interactionContext;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const interactionContext: InteractionContextInput = {
    ...(typeof record.language === 'string' ? { language: record.language } : {}),
    ...(typeof record.locale === 'string' ? { locale: record.locale } : {}),
    ...(typeof record.timezone === 'string' ? { timezone: record.timezone } : {}),
  };

  return Object.keys(interactionContext).length > 0 ? interactionContext : undefined;
}

/**
 * Extract sessionMetadata from A2A message.metadata for session-level state.
 * Returns undefined if not present or not a valid object.
 */
export function extractSessionMetadata(message: Message): Record<string, unknown> | undefined {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const sm = (metadata as Record<string, unknown>).sessionMetadata;
  if (!sm || typeof sm !== 'object' || Array.isArray(sm)) return undefined;
  return sm as Record<string, unknown>;
}

function buildStructuredResponsePayload(result: ExecutionResult): StructuredResponsePayload | null {
  const payload: StructuredResponsePayload = {};

  if (result.responseMetadata) {
    payload.responseMetadata = result.responseMetadata;
  }

  if (result.richContent && Object.keys(result.richContent).length > 0) {
    payload.richContent = result.richContent;
  }

  if (result.actions !== undefined) {
    payload.actions = result.actions;
  }

  return Object.keys(payload).length > 0 ? payload : null;
}

function buildResponseParts(result: ExecutionResult): Part[] {
  const parts: Part[] = [];

  if (result.response) {
    parts.push({ kind: 'text', text: result.response } as TextPart);
  }

  const structuredPayload = buildStructuredResponsePayload(result);
  if (structuredPayload) {
    parts.push({ kind: 'data', data: structuredPayload } as Part);
  }

  return parts;
}

/** Terminal A2A task states — tasks in these states cannot accept new messages. */
const TERMINAL_STATES = new Set<string>(['completed', 'failed', 'canceled', 'rejected']);

/** Suspension reason types that map to A2A 'input-required' state. */
const INPUT_REQUIRED_REASONS = new Set<string>(['human_approval', 'human_input']);

/**
 * Sentinel value returned when execution suspends.
 * Signals the caller to skip final status emission (already handled).
 */
const SUSPENDED_RESULT: ExecutionResult = Object.freeze({
  response: '',
  action: { type: 'suspend' },
});

/**
 * AgentExecutorAdapter bridges the A2A SDK's AgentExecutor interface
 * to the platform's AgentExecutionPort.
 *
 * Session identity: Uses contextId (via A2ASessionResolverPort) to map
 * to a persistent RuntimeSession, enabling multi-turn conversations.
 * Falls back to taskId when no session resolver is available.
 *
 * State transitions: Emits 'input-required' when execution suspends for
 * human approval/input, 'working' for async operations (remote handoff,
 * async tool). Emits 'rejected' when the coordinator rejects the request.
 *
 * When the execution port supports streaming (executeMessageStreaming),
 * the adapter emits incremental TaskArtifactUpdateEvent events as LLM
 * tokens arrive, enabling real-time SSE streaming to A2A clients.
 *
 * Every inbound call is traced with duration and success/error status.
 */
export class AgentExecutorAdapter implements AgentExecutor {
  private readonly agentName: string;
  private readonly executionPort: AgentExecutionPort;
  private readonly tracing: A2ATracingPort;
  private sessionResolver?: A2ASessionResolverPort;
  private readonly attachmentIngestor?: A2AAttachmentIngestor;

  constructor(config: AgentExecutorAdapterConfig) {
    this.agentName = config.agentName;
    this.executionPort = config.executionPort;
    this.tracing = config.tracing;
    this.sessionResolver = config.sessionResolver;
    this.attachmentIngestor = config.attachmentIngestor;
  }

  /**
   * Inject a session resolver after construction.
   * Used when the resolver depends on async infrastructure (Redis)
   * that isn't available at adapter creation time.
   */
  setSessionResolver(resolver: A2ASessionResolverPort): void {
    this.sessionResolver = resolver;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const start = Date.now();
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;
    const { text, attachments } = extractContentFromParts(requestContext.userMessage.parts);

    // Enrich text with file attachment references so the agent knows about them.
    // Full multimodal processing depends on the agent's LLM/tool configuration.
    let messageText =
      attachments.length > 0
        ? `${text}\n\n[Attachments: ${attachments.map((a) => a.name || a.uri || 'file').join(', ')}]`
        : text;

    // Inject conversation history from the calling agent's session.
    // The outbound side places history in message.metadata.history so it survives
    // the SDK's RequestContext creation (MessageSendParams.metadata does NOT).
    const inboundHistory = requestContext.userMessage.metadata?.history as
      | Array<{ role: string; content: string }>
      | undefined;
    if (inboundHistory && inboundHistory.length > 0) {
      const historyLines = inboundHistory.map((m) => `[${m.role}]: ${m.content}`);
      messageText = `[Conversation History]\n${historyLines.join('\n')}\n\n[Current Message]\n${messageText}`;
      log.debug('Injected conversation history from calling agent', {
        taskId,
        contextId,
        historyTurns: inboundHistory.length,
      });
    }

    // Inject reference task context — prior task results referenced by this message
    if (requestContext.referenceTasks && requestContext.referenceTasks.length > 0) {
      const refSummaries = requestContext.referenceTasks.map((refTask) => {
        const refText = refTask.history
          ?.filter((m: { role: string }) => m.role === 'agent')
          .map(
            (m: { parts?: Array<{ kind: string; text?: string }> }) =>
              m.parts
                ?.filter((p) => p.kind === 'text')
                .map((p) => p.text)
                .join('') ?? '',
          )
          .join('\n');
        return `[Task ${refTask.id} (${refTask.status.state})]: ${refText || 'no content'}`;
      });
      messageText += `\n\n[Referenced Tasks]\n${refSummaries.join('\n')}`;
    }

    // Warn on empty message text (downstream executor may handle it)
    if (!messageText || messageText.trim().length === 0) {
      log.warn('A2A task received with empty message text', {
        taskId,
        contextId,
      });
    }

    // Terminal state guard (defense-in-depth; SDK already guards this)
    if (requestContext.task && TERMINAL_STATES.has(requestContext.task.status.state)) {
      throw new Error(`Task ${taskId} is in terminal state: ${requestContext.task.status.state}`);
    }

    // Resolve request context and session
    const context = this.requireContext();
    const sessionMetadata = extractSessionMetadata(requestContext.userMessage);
    const interactionContext = extractInteractionContext(requestContext.userMessage);
    const sessionContext: A2ARequestContext = {
      ...context,
      ...(interactionContext ? { interactionContext } : {}),
      ...(sessionMetadata ? { metadata: sessionMetadata } : {}),
    };
    const sessionId = await this.resolveSessionId(contextId, taskId, sessionContext);
    const attachmentIds = await this.ingestAttachments(attachments, sessionId, context);
    const inboundMessageMetadata = extractInboundMessageMetadata(requestContext.userMessage);
    const executionContext: A2ARequestContext = {
      ...context,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(interactionContext ? { interactionContext } : {}),
      ...(inboundMessageMetadata !== undefined ? { messageMetadata: inboundMessageMetadata } : {}),
      ...(sessionMetadata ? { metadata: sessionMetadata } : {}),
    };

    try {
      // 1. Emit "working" status immediately so SSE clients see progress
      const workingStatus: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId,
        contextId,
        status: { state: 'working' },
        final: false,
      };
      eventBus.publish(workingStatus);

      let result: ExecutionResult;

      if (this.executionPort.executeMessageStreaming) {
        // STREAMING PATH: bridge onChunk -> TaskArtifactUpdateEvent
        // Supports suspension detection via Promise.race
        result = await this.executeWithStreaming(
          sessionId,
          taskId,
          contextId,
          messageText,
          eventBus,
          executionContext,
        );
      } else {
        // SYNC FALLBACK: await full result, publish single Message
        result = await this.executeSync(
          sessionId,
          taskId,
          contextId,
          messageText,
          eventBus,
          executionContext,
        );
      }

      // If execution suspended, status events were already emitted by the
      // suspension handler — skip final status and just trace.
      if (result.action?.type === 'suspend') {
        this.tracing.traceInbound({
          sourceIp: 'a2a-protocol',
          taskId,
          tenantId: context.tenantId,
          agentName: this.agentName,
          durationMs: Date.now() - start,
          status: 'success',
        });
        return;
      }

      // Determine final task state. Per A2A spec, 'working' is non-terminal
      // and should not be sent with final: true. Map all completed executions
      // to 'completed' — the task's unit of work is done.
      const finalState: TaskState = 'completed';

      // Emit final status (terminates the SSE stream)
      const finalStatus: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId,
        contextId,
        status: { state: finalState },
        final: true,
      };
      eventBus.publish(finalStatus);
      eventBus.finished();

      // Session mapping is NOT deleted on task completion.
      // In A2A multi-turn, each "turn" is a separate task sharing the same contextId.
      // Deleting the mapping after turn 1 would force turn 2 to create a new session,
      // breaking conversation continuity. Session mappings are cleaned up via:
      //   - TTL expiry (default 24h, refreshed on each touchSession)
      //   - Explicit closeSession on 'failed' (catch block below)
      // This matches the A2A spec where contextId represents an ongoing conversation.

      this.tracing.traceInbound({
        sourceIp: 'a2a-protocol',
        taskId,
        tenantId: context.tenantId,
        agentName: this.agentName,
        durationMs: Date.now() - start,
        status: 'success',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Emit failed status (terminates the SSE stream)
      const failedStatus: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId,
        contextId,
        status: { state: 'failed' },
        final: true,
      };
      eventBus.publish(failedStatus);
      eventBus.finished();

      // Clean up session mapping on failure
      if (this.sessionResolver) {
        await this.sessionResolver.closeSession(contextId, context.tenantId).catch((closeErr) => {
          log.warn('Failed to close A2A session mapping after error', {
            contextId,
            tenantId: context.tenantId,
            error: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        });
      }

      this.tracing.traceInbound({
        sourceIp: 'a2a-protocol',
        taskId,
        tenantId: context.tenantId,
        agentName: this.agentName,
        durationMs: Date.now() - start,
        status: 'error',
        error: errorMessage,
      });
      throw error;
    }
  }

  private async ingestAttachments(
    attachments: A2AAttachment[],
    sessionId: string,
    context: A2ARequestContext,
  ): Promise<string[]> {
    if (!this.attachmentIngestor || attachments.length === 0) {
      return [];
    }

    try {
      return await this.attachmentIngestor({ attachments, sessionId, context });
    } catch (err) {
      log.warn('A2A attachment ingestion failed; continuing with text-only fallback', {
        sessionId,
        attachmentCount: attachments.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Returns the current request context from AsyncLocalStorage.
   * Every request must be wrapped in a2aContextStorage.run().
   */
  private requireContext(): A2ARequestContext {
    const ctx = a2aContextStorage.getStore();
    if (!ctx) {
      throw new Error(
        'A2ARequestContext not set — request must be wrapped in a2aContextStorage.run()',
      );
    }
    return ctx;
  }

  /**
   * Resolve A2A contextId to a platform session ID.
   * When a session resolver is available, maps contextId → sessionId
   * for persistent multi-turn conversations. Creates a new session
   * via the execution port when no mapping exists. Falls back to
   * taskId when no resolver is configured (backward compatibility).
   *
   * Uses atomic register-if-absent when available to prevent concurrent
   * first-turn requests from forking into separate sessions.
   */
  private async resolveSessionId(
    contextId: string,
    taskId: string,
    context: A2ARequestContext,
  ): Promise<string> {
    if (!this.sessionResolver) return taskId;

    // Phase 1: Existing session?
    const resolved = await this.sessionResolver.resolveSession(contextId, context.tenantId);
    if (!resolved.isNew) {
      await this.sessionResolver.touchSession(contextId, context.tenantId);
      return resolved.sessionId;
    }

    // Phase 2: Create new session via execution port
    const sessionId = await this.executionPort.createSession(context);

    // Phase 3: Atomic registration — if another request won the race,
    // discard our session and use the winner's
    if (this.sessionResolver.registerSessionIfAbsent) {
      const result = await this.sessionResolver.registerSessionIfAbsent(
        contextId,
        context.tenantId,
        sessionId,
      );
      if (result.alreadyExisted) {
        log.info('Session race resolved — using winner session', {
          contextId,
          discardedSessionId: sessionId,
          winnerSessionId: result.sessionId,
        });
      }
      return result.sessionId;
    }

    // Fallback: non-atomic register (backward compat for custom resolvers)
    await this.sessionResolver.registerSession(contextId, context.tenantId, sessionId);
    return sessionId;
  }

  /**
   * Emit a suspension status event on the A2A event bus.
   * Maps platform suspension reasons to A2A task states:
   * - human_approval / human_input → 'input-required'
   * - everything else (async_tool, remote_handoff) → 'working'
   */
  private emitSuspensionStatus(
    taskId: string,
    contextId: string,
    reason: { type?: string } | undefined,
    eventBus: ExecutionEventBus,
  ): void {
    const a2aState: TaskState =
      reason?.type && INPUT_REQUIRED_REASONS.has(reason.type) ? 'input-required' : 'working';

    const suspendedStatus: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: a2aState },
      final: true,
    };
    eventBus.publish(suspendedStatus);
    eventBus.finished();
  }

  /**
   * Streaming execution: calls executeMessageStreaming and publishes
   * each token chunk as a TaskArtifactUpdateEvent on the event bus.
   *
   * When the coordinator suspends execution (async tool, human approval),
   * the execution promise never resolves. We detect this via onTraceEvent
   * and race against a suspension promise to unblock cleanly.
   */
  private async executeWithStreaming(
    sessionId: string,
    taskId: string,
    contextId: string,
    text: string,
    eventBus: ExecutionEventBus,
    context: A2ARequestContext,
  ): Promise<ExecutionResult> {
    const artifactId = `stream-${taskId}`;
    let chunkIndex = 0;
    let suspended = false;

    // Suspension detection: resolves when onTraceEvent fires 'execution_suspended'
    let resolveSuspension: ((result: ExecutionResult) => void) | null = null;
    const suspensionPromise = new Promise<ExecutionResult>((resolve) => {
      resolveSuspension = resolve;
    });

    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'execution_suspended' && resolveSuspension) {
        suspended = true;
        const reason = event.data.reason as { type?: string } | undefined;
        this.emitSuspensionStatus(taskId, contextId, reason, eventBus);
        resolveSuspension(SUSPENDED_RESULT);
        resolveSuspension = null;
      }
    };

    const executionPromise = this.executionPort.executeMessageStreaming!(
      sessionId,
      text,
      (chunk: string) => {
        if (suspended) return; // Stop emitting chunks after suspension
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId,
          contextId,
          artifact: {
            artifactId,
            name: 'response-stream',
            parts: [{ kind: 'text', text: chunk }],
          },
          append: chunkIndex > 0,
          lastChunk: false,
        };
        eventBus.publish(artifactUpdate);
        chunkIndex++;
      },
      onTraceEvent,
      context,
    );

    // Race: normal completion OR suspension detected
    const result = await Promise.race([executionPromise, suspensionPromise]);
    // Release closure references from the losing promise to allow GC
    resolveSuspension = null;

    if (result.action?.type === 'suspend') {
      return result;
    }

    // Normal completion: emit last-chunk marker if we streamed any content
    if (chunkIndex > 0) {
      const lastArtifact: TaskArtifactUpdateEvent = {
        kind: 'artifact-update',
        taskId,
        contextId,
        artifact: {
          artifactId,
          name: 'response-stream',
          parts: [{ kind: 'text', text: '' }],
        },
        append: true,
        lastChunk: true,
      };
      eventBus.publish(lastArtifact);
    }

    // Publish a Task event with 'completed' status and the agent response
    // as an artifact BEFORE the Message event.
    //
    // Why: The SDK's ExecutionEventQueue stops yielding events when it
    // encounters a 'message' or a 'status-update' with final=true.
    // If we publish the 'completed' status-update AFTER the message,
    // the ResultManager never processes it, leaving the task in 'working'
    // state in the InMemoryTaskStore. By publishing a Task event first,
    // the ResultManager updates currentTask with 'completed' status and
    // saves it to the store — making getTask return the correct state.
    const responseParts = buildResponseParts(result);

    const completedTask: Task = {
      kind: 'task',
      id: taskId,
      contextId,
      status: { state: 'completed' },
      artifacts:
        responseParts.length > 0
          ? [
              {
                artifactId: `stream-${taskId}`,
                parts: responseParts,
              },
            ]
          : undefined,
    };
    eventBus.publish(completedTask);

    // Always publish a Message event with the final response payload.
    // The SDK's ResultManager only captures 'message' and 'task' events —
    // artifact-update events are ignored for the blocking (message/send) path.
    // Without this, sendMessage returns "no result found" even when streaming succeeded.
    if (responseParts.length > 0) {
      const responseMessage: Message = {
        kind: 'message',
        messageId: `resp-${taskId}-${Date.now()}`,
        role: 'agent',
        parts: responseParts,
      };
      eventBus.publish(responseMessage);
    }

    return result;
  }

  /**
   * Synchronous execution fallback: awaits the full result and publishes
   * a single Message event (backward compatible with non-streaming callers).
   *
   * Detects suspension via result.action.type === 'suspend' and emits
   * the appropriate A2A state transition.
   */
  private async executeSync(
    sessionId: string,
    taskId: string,
    contextId: string,
    text: string,
    eventBus: ExecutionEventBus,
    context: A2ARequestContext,
  ): Promise<ExecutionResult> {
    const result = await this.executionPort.executeMessage(sessionId, text, context);

    // If execution suspended, emit input-required / working and return sentinel
    if (result.action?.type === 'suspend') {
      const reason = result.action.reason as { type?: string } | undefined;
      this.emitSuspensionStatus(taskId, contextId, reason, eventBus);
      return SUSPENDED_RESULT;
    }

    const responseParts = buildResponseParts(result);

    // Publish completed Task event before the Message (see streaming path comment)
    const completedTask: Task = {
      kind: 'task',
      id: taskId,
      contextId,
      status: { state: 'completed' },
      artifacts:
        responseParts.length > 0
          ? [
              {
                artifactId: `resp-${taskId}`,
                parts: responseParts,
              },
            ]
          : undefined,
    };
    eventBus.publish(completedTask);

    // Publish the full response payload as a single Message
    if (responseParts.length > 0) {
      const responseMessage: Message = {
        kind: 'message',
        messageId: `resp-${taskId}-${Date.now()}`,
        role: 'agent',
        parts: responseParts,
      };
      eventBus.publish(responseMessage);
    }

    return result;
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    // Publish a canceled status event.
    // NOTE: contextId should ideally come from the task store, but the SDK's
    // AgentExecutor interface only provides taskId. Using taskId as fallback
    // is acceptable since the SDK's ResultManager will reconcile via the store.
    const canceledStatus: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId: taskId,
      status: { state: 'canceled' },
      final: true,
    };
    eventBus.publish(canceledStatus);
    eventBus.finished();

    // Session cleanup on cancel is handled by TTL expiry.
    // The cancel endpoint receives taskId, not contextId, so we cannot
    // look up the session mapping directly.
  }
}

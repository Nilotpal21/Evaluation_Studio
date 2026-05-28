/**
 * Voice Runtime
 *
 * Low-latency runtime optimized for voice interactions.
 * Key characteristics:
 * - Sub-500ms response targets
 * - Streaming responses (token-by-token)
 * - Parallel tool execution
 * - Aggressive timeouts
 * - ALWAYS captures transcripts (even abandoned/failed calls)
 *
 * IMPORTANT: All voice interactions are recorded regardless of outcome.
 * This ensures compliance, debugging, and analytics for:
 * - Completed calls
 * - Abandoned calls (user hung up)
 * - Failed calls (system errors)
 * - Transferred calls
 *
 * Now integrated with ConstructExecutor for consistent DSL construct execution.
 * Extends BaseRuntime for shared infrastructure (stores, agent registration, context building).
 */

import { randomUUID } from 'crypto';
import type { AgentIR, ToolDefinition } from '../ir/schema.js';
import type {
  Session,
  Message,
  VoiceMetadata,
  Channel,
  CallDisposition,
  Environment,
} from '../core/types.js';
import type { ConversationStore } from '../stores/conversation-store.js';
import type { MessageStore } from '../stores/message-store.js';
import type { TraceProvider, TraceContextManager } from '../stores/trace-store.js';
import type { AuditStore } from '../stores/audit-store.js';
import type { FactStore } from '../stores/fact-store.js';
import {
  createInitialState,
  type ExecutionContext,
  type AgentState,
  type LLMClient as ConstructLLMClient,
  type ToolExecutor as ConstructToolExecutor,
  type RuntimeType,
} from '../constructs/index.js';
import {
  BaseRuntime,
  type BaseRuntimeConfig,
  type BaseRuntimeOptions,
  type BuildContextParams,
} from './base-runtime.js';
import { DEFAULT_MESSAGES } from '../constants.js';
import { createLogger } from '../logger.js';

// =============================================================================
// INTERFACES
// =============================================================================

export interface VoiceRuntimeConfig extends BaseRuntimeConfig {
  /** Target latency for response (ms) */
  latencyTargetMs: number;

  /** Enable streaming responses */
  streamingEnabled: boolean;

  /** Max concurrent tool calls */
  maxParallelTools: number;

  /** Transcript retention policy */
  transcriptRetention: 'always' | 'on_success' | 'never';
}

export interface VoiceSession {
  session: Session;
  callMetadata: VoiceMetadata;
  transcriptBuffer: TranscriptEntry[];
  isActive: boolean;
  startTime: Date;
  lastActivityTime: Date;
  /** Agent state managed by ConstructExecutor */
  agentState: AgentState;
}

export interface TranscriptEntry {
  timestamp: Date;
  speaker: 'user' | 'agent' | 'system';
  content: string;
  confidence?: number;
  isFinal: boolean;
  metadata?: Record<string, unknown>;
}

export interface VoiceInput {
  /** Transcribed text from ASR */
  transcript: string;

  /** ASR confidence score (0-1) */
  confidence: number;

  /** Is this a final transcript (vs interim) */
  isFinal: boolean;

  /** Raw audio data (optional, for logging) */
  audioData?: Buffer;
}

export interface VoiceOutput {
  /** Text to synthesize */
  text: string;

  /** Is this the final response chunk */
  isFinal: boolean;

  /** SSML for TTS (optional) */
  ssml?: string;

  /** Emotion/tone hints for TTS */
  emotion?: 'neutral' | 'empathetic' | 'urgent' | 'cheerful';

  /** Action type (for handling escalations, completions, etc.) */
  actionType?: 'response' | 'escalation' | 'handoff' | 'complete';
}

export interface LLMClient {
  streamChat(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    options: { model: string; timeoutMs: number },
  ): AsyncIterable<string>;

  chat(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    options: { model: string; timeoutMs: number },
  ): Promise<string>;

  extractJson?(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    schema: string,
    options: { model: string; timeoutMs: number },
  ): Promise<Record<string, unknown>>;
}

export interface ToolExecutor {
  execute(toolName: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;

  executeParallel?(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>>;
}

// =============================================================================
// VOICE RUNTIME
// =============================================================================

export class VoiceRuntime extends BaseRuntime {
  private readonly log = createLogger('voice-runtime');
  private llmClient: LLMClient;
  private toolExecutor: ToolExecutor;
  private activeSessions: Map<string, VoiceSession> = new Map();

  constructor(
    config: VoiceRuntimeConfig,
    conversationStore: ConversationStore,
    messageStore: MessageStore,
    traceStore: TraceProvider,
    auditStore: AuditStore,
    factStore: FactStore,
    llmClient: LLMClient,
    toolExecutor: ToolExecutor,
    options?: Omit<BaseRuntimeOptions, 'constructExecutor'>,
  ) {
    super(config, conversationStore, messageStore, traceStore, auditStore, factStore, options);
    this.llmClient = llmClient;
    this.toolExecutor = toolExecutor;
  }

  get runtimeType(): RuntimeType {
    return 'voice';
  }

  /**
   * Start a new voice session
   */
  async startSession(
    callMetadata: VoiceMetadata,
    agentName: string,
    agentVersion: string,
    customerId?: string,
  ): Promise<VoiceSession> {
    const environment = this.config.environment || 'production';

    // Create conversation session
    const session = await this.conversationStore.createSession({
      customerId,
      channel: 'voice',
      environment,
      agentName,
      agentVersion,
      metadata: {
        voiceMetadata: callMetadata,
        tags: ['voice_call'],
      },
    });

    // Record voice metadata
    await this.conversationStore.recordVoiceMetadata(session.id, callMetadata);

    // Create initial agent state
    const agentState = createInitialState({
      sessionId: session.id,
      channel: 'voice',
      customerId,
    });

    // Create voice session
    const voiceSession: VoiceSession = {
      session,
      callMetadata,
      transcriptBuffer: [],
      isActive: true,
      startTime: new Date(),
      lastActivityTime: new Date(),
      agentState,
    };

    this.activeSessions.set(session.id, voiceSession);

    // Emit event
    this.emit('session:started', voiceSession);

    return voiceSession;
  }

  /**
   * Process voice input and stream response
   * This is the main entry point for voice turns
   */
  async *processVoiceInput(sessionId: string, input: VoiceInput): AsyncGenerator<VoiceOutput> {
    const voiceSession = this.activeSessions.get(sessionId);
    if (!voiceSession) {
      throw new Error(`Voice session ${sessionId} not found`);
    }

    const startTime = Date.now();
    voiceSession.lastActivityTime = new Date();

    // ALWAYS record the transcript immediately (even if we fail later)
    await this.recordTranscript(voiceSession, {
      timestamp: new Date(),
      speaker: 'user',
      content: input.transcript,
      confidence: input.confidence,
      isFinal: input.isFinal,
    });

    // Only process final transcripts
    if (!input.isFinal) {
      return;
    }

    // Get agent IR
    const agentIR = this.agentIRs.get(voiceSession.session.currentAgent);
    if (!agentIR) {
      yield* this.handleError(voiceSession, 'Agent not found');
      return;
    }

    // Start trace
    const trace = this.traceStore.startTrace({
      sessionId,
      agentName: agentIR.metadata.name,
      agentVersion: agentIR.metadata.version,
      environment: voiceSession.session.environment,
    });

    try {
      // Add user message to store
      await this.messageStore.addMessage({
        sessionId,
        role: 'user',
        content: input.transcript,
        channel: 'voice',
        traceId: trace.traceId,
        metadata: {
          transcriptConfidence: input.confidence,
          voiceType: 'asr',
        },
      });

      // Build execution context for ConstructExecutor
      const voiceConfig = this.config as VoiceRuntimeConfig;
      const executionContext = super.buildExecutionContext({
        sessionId: voiceSession.session.id,
        agentIR,
        state: voiceSession.agentState,
        userInput: input.transcript,
        trace,
        runtimeType: 'voice',
        extraConfig: {
          maxParallelTools: voiceConfig.maxParallelTools,
        },
      });

      // Execute constructs - voice uses pattern-based extraction for speed
      const executionResult = await this.constructExecutor.execute(executionContext, {
        stopOnAction: true,
      });

      // Update session state
      voiceSession.agentState = executionResult.state;

      // Handle the action result
      const action = executionResult.action;

      switch (action.type) {
        case 'escalate':
          yield* this.handleEscalation(voiceSession, action, trace);
          return;

        case 'handoff':
          yield* this.handleHandoff(voiceSession, action, trace);
          return;

        case 'complete':
          yield* this.handleCompletion(voiceSession, action, trace);
          return;

        case 'respond':
          // Stream the response
          for (const chunk of this.chunkResponse(action.message)) {
            yield { text: chunk, isFinal: false };
          }
          yield { text: '', isFinal: true };

          // Record response
          await this.recordAndStoreResponse(voiceSession, action.message, trace);
          return;

        case 'collect':
          // For voice, we need to prompt for the first missing field
          const firstField = action.fields[0];
          const prompt = action.prompts[firstField] || `Please provide your ${firstField}`;
          yield* this.streamResponse(voiceSession, prompt, trace);
          return;

        case 'continue':
        default:
          // No specific action - generate LLM response
          yield* this.generateLLMResponse(voiceSession, agentIR, input.transcript, trace);
      }

      // Check latency target
      const totalTime = Date.now() - startTime;
      if (totalTime > voiceConfig.latencyTargetMs) {
        this.emit('latency:warning', {
          sessionId,
          targetMs: voiceConfig.latencyTargetMs,
          actualMs: totalTime,
        });
      }
    } catch (error) {
      // ALWAYS capture the error in transcript
      await this.recordTranscript(voiceSession, {
        timestamp: new Date(),
        speaker: 'system',
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        isFinal: true,
        metadata: { error: true },
      });

      await trace.logError(
        'processing_error',
        error instanceof Error ? error.message : 'Unknown error',
        error instanceof Error ? error.stack : undefined,
      );

      yield* this.handleError(
        voiceSession,
        error instanceof Error ? error.message : 'Unknown error',
      );
    } finally {
      await trace.end();
    }
  }

  /**
   * Adapt LLM client to ConstructExecutor interface
   */
  protected adaptLLMClient(): ConstructLLMClient {
    return {
      chat: (systemPrompt, messages, options) =>
        this.llmClient.chat(systemPrompt, messages, options),
      chatWithTools: async (systemPrompt, messages, tools, options) => {
        const text = await this.llmClient.chat(
          systemPrompt,
          messages.map((m) => ({
            role: typeof m.content === 'string' ? m.role : m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          options,
        );
        return { text, toolCalls: [], stopReason: 'end_turn' as const };
      },
      streamChat: this.llmClient.streamChat?.bind(this.llmClient),
      extractJson: this.llmClient.extractJson?.bind(this.llmClient) || (async () => ({})),
    };
  }

  /**
   * Adapt tool executor to ConstructExecutor interface
   */
  protected adaptToolExecutor(): ConstructToolExecutor {
    return {
      execute: (toolName, params, timeoutMs) =>
        this.toolExecutor.execute(toolName, params, timeoutMs),
      executeParallel:
        this.toolExecutor.executeParallel?.bind(this.toolExecutor) ||
        (async (calls, timeoutMs) => {
          const results = await Promise.allSettled(
            calls.map(async (call) => {
              try {
                const result = await this.toolExecutor.execute(call.name, call.params, timeoutMs);
                return { name: call.name, result };
              } catch (error) {
                return {
                  name: call.name,
                  error: error instanceof Error ? error.message : 'Unknown',
                };
              }
            }),
          );
          return results.map((r, i) =>
            r.status === 'fulfilled' ? r.value : { name: calls[i].name, error: 'Failed' },
          );
        }),
    };
  }

  /**
   * Stream a response with chunking for voice
   */
  private async *streamResponse(
    voiceSession: VoiceSession,
    response: string,
    trace: TraceContextManager,
  ): AsyncGenerator<VoiceOutput> {
    for (const chunk of this.chunkResponse(response)) {
      yield { text: chunk, isFinal: false };
    }
    yield { text: '', isFinal: true };

    await this.recordAndStoreResponse(voiceSession, response, trace);
  }

  /**
   * Generate LLM response with streaming
   */
  private async *generateLLMResponse(
    voiceSession: VoiceSession,
    agentIR: AgentIR,
    userInput: string,
    trace: TraceContextManager,
  ): AsyncGenerator<VoiceOutput> {
    // Get conversation history
    const history = await this.messageStore.getMessages({
      sessionId: voiceSession.session.id,
      limit: 10,
      includeSystem: false,
    });

    const messages = history.map((m) => ({ role: m.role, content: m.content }));

    // Add context from state
    const contextStr =
      Object.keys(voiceSession.agentState.context).length > 0
        ? `\nCurrent context: ${JSON.stringify(voiceSession.agentState.context)}`
        : '';

    const systemPrompt = agentIR.identity.system_prompt.template + contextStr;

    // Stream response
    let fullResponse = '';
    const responseStartTime = Date.now();

    try {
      for await (const token of this.llmClient.streamChat(systemPrompt, messages, {
        model: this.config.model,
        timeoutMs: this.config.llmTimeoutMs,
      })) {
        fullResponse += token;
        yield { text: token, isFinal: false };
      }

      yield { text: '', isFinal: true };

      // Log and store
      await trace.logLLMCall({
        model: this.config.model,
        messages,
        response: fullResponse,
        tokensIn: this.estimateTokens(messages),
        tokensOut: this.estimateTokens([{ role: 'assistant', content: fullResponse }]),
        latencyMs: Date.now() - responseStartTime,
      });

      await this.recordAndStoreResponse(voiceSession, fullResponse, trace);
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        const agentIR = this.agentIRs.get(voiceSession.session.currentAgent);
        const repeatMsg = agentIR?.messages?.voice_repeat || DEFAULT_MESSAGES.voice_repeat;
        yield { text: repeatMsg, isFinal: false };
        yield { text: '', isFinal: true };
      } else {
        throw error;
      }
    }
  }

  /**
   * Handle escalation action
   */
  private async *handleEscalation(
    voiceSession: VoiceSession,
    action: { type: 'escalate'; reason: string; priority: string },
    trace: TraceContextManager,
  ): AsyncGenerator<VoiceOutput> {
    const agentIR = this.agentIRs.get(voiceSession.session.currentAgent);
    const message = agentIR?.messages?.escalation_format || DEFAULT_MESSAGES.escalation_format;

    yield { text: message, isFinal: true, actionType: 'escalation', emotion: 'empathetic' };

    await this.recordAndStoreResponse(voiceSession, message, trace);

    await trace.logEscalation(action.reason, action.priority, voiceSession.agentState.context);

    this.emit('escalation:triggered', {
      sessionId: voiceSession.session.id,
      reason: action.reason,
      priority: action.priority,
    });
  }

  /**
   * Handle handoff action
   */
  private async *handleHandoff(
    voiceSession: VoiceSession,
    action: { type: 'handoff'; target: string; context: Record<string, unknown> },
    trace: TraceContextManager,
  ): AsyncGenerator<VoiceOutput> {
    const message = `I'm transferring you to ${action.target}. Please hold.`;

    yield { text: message, isFinal: true, actionType: 'handoff', emotion: 'neutral' };

    await this.recordAndStoreResponse(voiceSession, message, trace);

    await trace.logHandoff(action.target, 'Voice handoff', action.context);

    this.emit('handoff:triggered', {
      sessionId: voiceSession.session.id,
      target: action.target,
      context: action.context,
    });
  }

  /**
   * Handle completion action
   */
  private async *handleCompletion(
    voiceSession: VoiceSession,
    action: { type: 'complete'; message?: string },
    trace: TraceContextManager,
  ): AsyncGenerator<VoiceOutput> {
    const agentIR = this.agentIRs.get(voiceSession.session.currentAgent);
    const message =
      action.message ||
      agentIR?.messages?.conversation_complete ||
      DEFAULT_MESSAGES.conversation_complete;

    yield { text: message, isFinal: true, actionType: 'complete', emotion: 'cheerful' };

    await this.recordAndStoreResponse(voiceSession, message, trace);

    // End session
    await this.endSession(voiceSession.session.id, 'completed');
  }

  /**
   * Record response in transcript and store
   */
  private async recordAndStoreResponse(
    voiceSession: VoiceSession,
    response: string,
    trace: TraceContextManager,
  ): Promise<void> {
    await this.recordTranscript(voiceSession, {
      timestamp: new Date(),
      speaker: 'agent',
      content: response,
      isFinal: true,
    });

    await this.messageStore.addMessage({
      sessionId: voiceSession.session.id,
      role: 'assistant',
      content: response,
      channel: 'voice',
      traceId: trace.traceId,
      metadata: {
        model: this.config.model,
        voiceType: 'tts',
      },
    });
  }

  /**
   * Chunk response for streaming
   */
  private *chunkResponse(response: string): Generator<string> {
    // For voice, we can send larger chunks
    const words = response.split(' ');
    let chunk = '';

    for (const word of words) {
      chunk += (chunk ? ' ' : '') + word;
      if (chunk.length >= 20 || word.endsWith('.') || word.endsWith('?') || word.endsWith('!')) {
        yield chunk;
        chunk = '';
      }
    }

    if (chunk) {
      yield chunk;
    }
  }

  /**
   * End a voice session
   */
  async endSession(
    sessionId: string,
    disposition: CallDisposition,
    reason?: string,
  ): Promise<void> {
    const voiceSession = this.activeSessions.get(sessionId);
    if (!voiceSession) {
      await this.conversationStore.captureAbandonedCall(sessionId, '', reason || disposition);
      return;
    }

    const durationMs = Date.now() - voiceSession.startTime.getTime();

    await this.recordTranscript(voiceSession, {
      timestamp: new Date(),
      speaker: 'system',
      content: `Call ended: ${disposition}${reason ? ` - ${reason}` : ''}`,
      isFinal: true,
      metadata: {
        disposition,
        durationMs,
        transcriptCount: voiceSession.transcriptBuffer.length,
      },
    });

    await this.flushTranscriptBuffer(voiceSession);

    await this.conversationStore.recordVoiceMetadata(sessionId, {
      ...voiceSession.callMetadata,
      durationSeconds: Math.floor(durationMs / 1000),
    });

    await this.conversationStore.endSession(sessionId, disposition);

    voiceSession.isActive = false;
    this.activeSessions.delete(sessionId);

    this.emit('session:ended', { sessionId, disposition, durationMs });
  }

  /**
   * Handle abandoned call - CRITICAL for compliance
   */
  async handleAbandonedCall(
    sessionId: string,
    lastTranscript?: string,
    reason: string = 'User disconnected',
  ): Promise<void> {
    const voiceSession = this.activeSessions.get(sessionId);

    if (voiceSession) {
      await this.recordTranscript(voiceSession, {
        timestamp: new Date(),
        speaker: 'system',
        content: `Call abandoned: ${reason}`,
        isFinal: true,
        metadata: { abandoned: true },
      });

      await this.flushTranscriptBuffer(voiceSession);
    }

    // Session state: mark as abandoned
    await this.conversationStore.captureAbandonedCall(sessionId, lastTranscript || '', reason);

    // Save transcript messages via MessageStore
    if (lastTranscript) {
      await this.messageStore.addMessage({
        sessionId,
        role: 'user',
        content: lastTranscript,
        channel: 'voice',
        traceId: randomUUID(),
        metadata: {
          voiceType: 'asr',
          transcriptConfidence: 0,
        },
      });

      await this.messageStore.addMessage({
        sessionId,
        role: 'system',
        content: `Call abandoned: ${reason}`,
        channel: 'voice',
        traceId: randomUUID(),
      });
    }

    await this.endSession(sessionId, 'abandoned', reason);

    this.emit('call:abandoned', { sessionId, reason, lastTranscript });
  }

  /**
   * Handle system failure during call
   */
  async handleCallFailure(sessionId: string, error: Error, lastTranscript?: string): Promise<void> {
    const voiceSession = this.activeSessions.get(sessionId);

    if (voiceSession) {
      await this.recordTranscript(voiceSession, {
        timestamp: new Date(),
        speaker: 'system',
        content: `System failure: ${error.message}`,
        isFinal: true,
        metadata: {
          error: true,
          errorType: error.name,
          errorStack: error.stack,
        },
      });

      await this.flushTranscriptBuffer(voiceSession);
    }

    // Session state: mark as abandoned
    await this.conversationStore.captureAbandonedCall(
      sessionId,
      lastTranscript || '',
      `System failure: ${error.message}`,
    );

    // Save transcript messages via MessageStore
    if (lastTranscript) {
      await this.messageStore.addMessage({
        sessionId,
        role: 'user',
        content: lastTranscript,
        channel: 'voice',
        traceId: randomUUID(),
        metadata: {
          voiceType: 'asr',
          transcriptConfidence: 0,
        },
      });

      await this.messageStore.addMessage({
        sessionId,
        role: 'system',
        content: `System failure: ${error.message}`,
        channel: 'voice',
        traceId: randomUUID(),
      });
    }

    await this.endSession(sessionId, 'failed', error.message);

    this.emit('call:failed', { sessionId, error });
  }

  // ==========================================================================
  // PRIVATE METHODS
  // ==========================================================================

  private async recordTranscript(
    voiceSession: VoiceSession,
    entry: TranscriptEntry,
  ): Promise<void> {
    try {
      voiceSession.transcriptBuffer.push(entry);

      if (voiceSession.transcriptBuffer.length > 50) {
        await this.flushTranscriptBuffer(voiceSession);
      }
    } catch (error) {
      this.log.error('Failed to record transcript', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushTranscriptBuffer(voiceSession: VoiceSession): Promise<void> {
    if (voiceSession.transcriptBuffer.length === 0) return;

    try {
      const transcriptJson = JSON.stringify(voiceSession.transcriptBuffer);

      await this.messageStore.addMessage({
        sessionId: voiceSession.session.id,
        role: 'system',
        content: `[TRANSCRIPT_BUFFER] ${transcriptJson}`,
        channel: 'voice',
        traceId: 'transcript-flush',
        metadata: {
          custom: {
            entryCount: voiceSession.transcriptBuffer.length,
            isTranscriptDump: true,
          },
        },
      });

      voiceSession.transcriptBuffer = [];
    } catch (error) {
      this.log.error('Failed to flush transcript buffer', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async *handleError(
    voiceSession: VoiceSession,
    errorMessage: string,
  ): AsyncGenerator<VoiceOutput> {
    const agentIR = this.agentIRs.get(voiceSession.session.currentAgent);
    const fallbackResponse = agentIR?.messages?.error_default || DEFAULT_MESSAGES.error_default;

    yield {
      text: fallbackResponse,
      isFinal: true,
      emotion: 'empathetic',
    };

    this.emit('escalation:required', {
      sessionId: voiceSession.session.id,
      reason: errorMessage,
      priority: 'high',
    });
  }

  private estimateTokens(messages: Array<{ role: string; content: string }>): number {
    return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createVoiceRuntime(
  config: VoiceRuntimeConfig,
  conversationStore: ConversationStore,
  messageStore: MessageStore,
  traceStore: TraceProvider,
  auditStore: AuditStore,
  factStore: FactStore,
  llmClient: LLMClient,
  toolExecutor: ToolExecutor,
): VoiceRuntime {
  return new VoiceRuntime(
    config,
    conversationStore,
    messageStore,
    traceStore,
    auditStore,
    factStore,
    llmClient,
    toolExecutor,
  );
}

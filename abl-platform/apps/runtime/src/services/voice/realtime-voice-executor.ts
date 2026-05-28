/**
 * Realtime Voice Executor
 *
 * Bridges the ABL flow engine (tools, constraints, handoffs, state)
 * with the RealtimeVoiceSession interface. Acts as the runtime
 * coordinator for realtime voice sessions.
 *
 * Responsibilities:
 * - Builds system prompt and tool definitions from AgentIR
 * - Routes tool calls from the realtime model to the ABL tool executor
 * - Runs constraint checks after tool execution
 * - Captures transcripts for compliance and conversation history
 * - Handles agent handoffs (prompt + tools update)
 * - Tracks usage metrics and emits trace events
 */

import { randomUUID } from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import type {
  NormalizedVoiceEvent,
  RealtimeVoiceSession,
  RealtimeSessionConfig,
  RealtimeToolCall,
  RealtimeTranscript,
  RealtimeUsageMetrics,
  RealtimeConnectionState,
} from '@abl/compiler/platform/llm/realtime/types.js';
import type { RuntimeSession } from '../execution/types.js';
import {
  startRealtimeVoiceTurn,
  recordRealtimeFirstAudioOut,
  recordRealtimeToolCall,
  completeRealtimeVoiceTurn,
  failRealtimeVoiceTurn,
  type RealtimeVoiceTurnContext,
  type RealtimeVoiceTimingBreakdown,
} from '../../observability/voice-trace.js';
import {
  recordRealtimeTurnComplete,
  recordRealtimeSessionStart,
  recordRealtimeSessionEnd,
  recordRealtimeInterruption,
} from '../../observability/voice-metrics.js';
import {
  REALTIME_VOICE_TURN_TOOL_NAME,
  type VoicePromptProfileDiagnostics,
  type VoicePromptProfileResult,
} from './voice-prompt-profile.js';
import { buildLiveVoicePromptSurface } from './live-voice-runtime-bridge.js';
import type {
  VoiceSemanticConvergenceMode,
  VoiceSemanticConvergencePlan,
  VoiceSemanticConvergenceStrategy,
} from './voice-semantic-convergence.js';

const log = createLogger('realtime-voice-executor');

// =============================================================================
// TYPES
// =============================================================================

export interface RealtimeVoiceExecutorConfig {
  sessionId: string;
  agentIR: AgentIR;
  runtimeSession?: RuntimeSession;
  sessionConfig: RealtimeSessionConfig;
  toolExecutor?: ToolExecutorFn;
  voiceTurnExecutor?: VoiceTurnExecutorFn;
  semanticConvergence?: VoiceSemanticConvergencePlan;
  constraintChecker?: ConstraintCheckerFn;
  onAudio?: (audio: Buffer) => void;
  onTranscript?: (entry: TranscriptEntry) => void;
  onStateUpdate?: (state: Record<string, unknown>) => void;
  onTurnEnd?: (metrics: TurnMetrics) => void;
  onError?: (error: Error) => void;
}

export interface RealtimeToolExecutionResult {
  result: string;
  activeAgentName?: string;
  activeAgentIR?: AgentIR | null;
}

export type ToolExecutorFn = (
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string,
) => Promise<string | RealtimeToolExecutionResult>;

export type VoiceTurnExecutorFn = (
  utterance: string,
  sessionId: string,
) => Promise<RealtimeToolExecutionResult>;

export type ConstraintCheckerFn = (
  state: Record<string, unknown>,
  agentIR: AgentIR,
) => Promise<{ passed: boolean; violations: string[] }>;

export interface TranscriptEntry {
  id: string;
  timestamp: Date;
  role: 'user' | 'assistant' | 'system';
  text: string;
  isFinal: boolean;
}

export interface TurnMetrics {
  turnId: string;
  durationMs: number;
  toolCalls: number;
  toolCallLatencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  // Trace context for OTEL correlation
  timingBreakdown?: RealtimeVoiceTimingBreakdown;
  traceId?: string;
  spanId?: string;
  semanticConvergence?: RealtimeSemanticTurnDiagnostics;
}

export interface RealtimeSemanticTurnDiagnostics {
  mode: VoiceSemanticConvergenceMode;
  strategy: VoiceSemanticConvergenceStrategy;
  family?: VoiceSemanticConvergencePlan['family'];
  providerType: RealtimeVoiceSession['providerType'];
  reason: VoiceSemanticConvergencePlan['reason'];
  usedCoordinatorTool: boolean;
  sawUserAudio: boolean;
  capturedFinalTranscript: boolean;
  bypassDetected: boolean;
}

// =============================================================================
// EXECUTOR
// =============================================================================

export class RealtimeVoiceExecutor {
  private session: RealtimeVoiceSession;
  private config: RealtimeVoiceExecutorConfig;
  private agentIR: AgentIR;
  private state: Record<string, unknown> = {};
  private transcripts: TranscriptEntry[] = [];
  private turnCount = 0;
  private startTime: number | null = null;
  private isRunning = false;

  // Per-turn tracking
  private currentTurnId: string | null = null;
  private currentTurnStart: number | null = null;
  private currentTurnToolCalls = 0;
  private currentTurnToolLatency = 0;
  private turnTraceCtx: RealtimeVoiceTurnContext | null = null;
  private promptProfileDiagnostics: VoicePromptProfileDiagnostics | null = null;
  private latestFinalUserTranscript: string | null = null;
  private currentTurnSawUserAudio = false;
  private currentTurnCapturedFinalTranscript = false;
  private currentTurnUsedCoordinatorTool = false;

  constructor(session: RealtimeVoiceSession, config: RealtimeVoiceExecutorConfig) {
    this.session = session;
    this.config = config;
    this.agentIR = config.agentIR;
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  async start(): Promise<void> {
    if (this.isRunning) return;

    // Wire up event handlers
    this.session.on('onToolCall', this.handleToolCall);
    this.session.on('onTranscript', this.handleTranscript);
    this.session.on('onTurnEnd', this.handleTurnEnd);
    this.session.on('onError', this.handleError);
    this.session.on('onInterrupted', this.handleInterrupted);
    this.session.on('onNormalizedEvent', this.handleNormalizedEvent);
    this.session.on('onConnectionStateChange', this.handleConnectionStateChange);
    this.session.on('onAudio', this.handleAudio);

    // Connect with config built from AgentIR
    const sessionConfig = this.buildSessionConfig();
    await this.session.connect(sessionConfig);

    this.startTime = Date.now();
    this.isRunning = true;

    recordRealtimeSessionStart(this.config.sessionId);

    log.info('Realtime voice executor started', {
      sessionId: this.config.sessionId,
      agent: this.agentIR.metadata.name,
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    // Fail any in-progress turn trace
    if (this.turnTraceCtx) {
      failRealtimeVoiceTurn(this.turnTraceCtx, 'session_stopped');
      this.turnTraceCtx = null;
    }

    recordRealtimeSessionEnd(this.config.sessionId, Date.now() - (this.startTime || Date.now()));

    // Disconnect session
    await this.session.disconnect();

    // Remove handlers
    this.session.off('onToolCall', this.handleToolCall);
    this.session.off('onTranscript', this.handleTranscript);
    this.session.off('onTurnEnd', this.handleTurnEnd);
    this.session.off('onError', this.handleError);
    this.session.off('onInterrupted', this.handleInterrupted);
    this.session.off('onNormalizedEvent', this.handleNormalizedEvent);
    this.session.off('onConnectionStateChange', this.handleConnectionStateChange);
    this.session.off('onAudio', this.handleAudio);

    this.isRunning = false;

    log.info('Realtime voice executor stopped', {
      sessionId: this.config.sessionId,
      turnCount: this.turnCount,
      durationMs: this.startTime ? Date.now() - this.startTime : 0,
    });
  }

  // ===========================================================================
  // AUDIO PROXY
  // ===========================================================================

  sendAudio(audio: Buffer): void {
    if (!this.isRunning) return;
    this.ensureTurnTrackingStarted();
    this.currentTurnSawUserAudio = true;
    this.session.sendAudio(audio);
  }

  cancelResponse(): void {
    if (!this.isRunning) return;
    this.session.cancelResponse();
  }

  // ===========================================================================
  // HANDOFF
  // ===========================================================================

  handleHandoff(targetAgentIR: AgentIR): void {
    this.agentIR = targetAgentIR;

    if (this.getSemanticStrategy() === 'coordinator_tool') {
      log.info('Realtime voice handoff preserved the coordinator-owned tool surface', {
        sessionId: this.config.sessionId,
        targetAgent: targetAgentIR.metadata.name,
        providerType: this.session.providerType,
        semanticMode: this.config.semanticConvergence?.mode ?? 'off',
      });
      return;
    }

    const promptProfile = this.buildPromptProfile(targetAgentIR);
    const capabilities = this.session.getCapabilityProfile().capabilities;

    if (capabilities.supportsPromptRefresh) {
      this.session.updateSystemPrompt(promptProfile.systemPrompt);
    } else {
      log.warn('Realtime provider does not support mid-call prompt refresh', {
        sessionId: this.config.sessionId,
        providerType: this.session.providerType,
        profile: promptProfile.profile,
      });
    }

    if (capabilities.supportsToolRefresh) {
      this.session.updateTools(promptProfile.tools);
    } else {
      log.warn('Realtime provider does not support mid-call tool refresh', {
        sessionId: this.config.sessionId,
        providerType: this.session.providerType,
        profile: promptProfile.profile,
      });
    }

    log.info('Realtime voice handoff', {
      sessionId: this.config.sessionId,
      targetAgent: targetAgentIR.metadata.name,
      providerType: this.session.providerType,
      promptProfile: promptProfile.profile,
      promptRefresh: promptProfile.diagnostics.promptRefresh,
      toolRefresh: promptProfile.diagnostics.toolRefresh,
    });
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  getTranscripts(): TranscriptEntry[] {
    return [...this.transcripts];
  }

  getState(): Record<string, unknown> {
    return { ...this.state };
  }

  getUsageMetrics(): RealtimeUsageMetrics {
    return this.session.getUsageMetrics();
  }

  getConnectionState(): RealtimeConnectionState {
    return this.session.connectionState;
  }

  getPromptProfileDiagnostics(): VoicePromptProfileDiagnostics | null {
    return this.promptProfileDiagnostics ? { ...this.promptProfileDiagnostics } : null;
  }

  // ===========================================================================
  // EVENT HANDLERS (bound to preserve `this`)
  // ===========================================================================

  private handleToolCall = async (toolCall: RealtimeToolCall): Promise<void> => {
    const callStart = Date.now();
    this.currentTurnToolCalls++;
    const isCoordinatorToolCall = toolCall.name === REALTIME_VOICE_TURN_TOOL_NAME;

    log.debug('Realtime tool call', {
      sessionId: this.config.sessionId,
      tool: toolCall.name,
      callId: toolCall.callId,
    });

    try {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        args = {};
      }

      let executionResult: RealtimeToolExecutionResult;
      if (isCoordinatorToolCall) {
        this.currentTurnUsedCoordinatorTool = true;
        const utterance = this.resolveVoiceTurnUtterance(args);
        if (!utterance) {
          throw new Error('Realtime voice turn tool requires a finalized utterance');
        }
        if (!this.config.voiceTurnExecutor) {
          throw new Error('Realtime voice turn executor is not configured');
        }

        executionResult = await this.config.voiceTurnExecutor(utterance, this.config.sessionId);
      } else if (this.getSemanticStrategy() === 'coordinator_tool') {
        throw new Error(
          `Direct realtime tool calls are disabled while ${REALTIME_VOICE_TURN_TOOL_NAME} is active`,
        );
      } else if (this.config.toolExecutor) {
        const toolResult = await this.config.toolExecutor(
          toolCall.name,
          args,
          this.config.sessionId,
        );
        executionResult = typeof toolResult === 'string' ? { result: toolResult } : toolResult;
      } else {
        executionResult = {
          result: JSON.stringify({ status: 'ok', message: `Tool ${toolCall.name} executed` }),
        };
      }

      const nextAgentIR = executionResult.activeAgentIR;
      const shouldRefreshAgent =
        nextAgentIR &&
        (nextAgentIR !== this.agentIR ||
          (typeof executionResult.activeAgentName === 'string' &&
            executionResult.activeAgentName.length > 0 &&
            executionResult.activeAgentName !== this.agentIR.metadata.name));

      if (shouldRefreshAgent && nextAgentIR) {
        if (isCoordinatorToolCall || this.getSemanticStrategy() === 'coordinator_tool') {
          this.agentIR = nextAgentIR;
        } else {
          this.handleHandoff(nextAgentIR);
        }
      }

      let result = executionResult.result;

      // Run constraint checks after tool execution
      if (!isCoordinatorToolCall && this.config.constraintChecker) {
        const check = await this.config.constraintChecker(this.state, this.agentIR);
        if (!check.passed) {
          result = JSON.stringify({
            status: 'constraint_violation',
            violations: check.violations,
            message: 'Action blocked by agent constraints',
          });
        }
      }

      this.session.submitToolResult(toolCall.callId, result);

      const latency = Date.now() - callStart;
      this.currentTurnToolLatency += latency;

      if (this.turnTraceCtx) {
        recordRealtimeToolCall(this.turnTraceCtx, toolCall.name, latency);
      }

      log.debug('Realtime tool call complete', {
        sessionId: this.config.sessionId,
        tool: toolCall.name,
        latencyMs: latency,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error('Realtime tool call failed', {
        sessionId: this.config.sessionId,
        tool: toolCall.name,
        error: errorMessage,
      });

      this.session.submitToolResult(
        toolCall.callId,
        JSON.stringify({ status: 'error', message: errorMessage }),
      );
    }
  };

  private handleTranscript = (transcript: RealtimeTranscript): void => {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      timestamp: new Date(),
      role: transcript.role,
      text: transcript.text,
      isFinal: transcript.isFinal,
    };

    if (transcript.isFinal) {
      this.transcripts.push(entry);
    }

    // Start turn tracking on first user transcript
    if (transcript.role === 'user' && !this.currentTurnId) {
      this.ensureTurnTrackingStarted();
    }

    if (transcript.role === 'user' && transcript.isFinal) {
      this.latestFinalUserTranscript = transcript.text;
      this.currentTurnCapturedFinalTranscript = true;
    }

    this.config.onTranscript?.(entry);
  };

  private handleTurnEnd = (usage: Partial<RealtimeUsageMetrics>): void => {
    this.turnCount++;

    let timingBreakdown: RealtimeVoiceTimingBreakdown | undefined;
    let traceId: string | undefined;
    let spanId: string | undefined;

    if (this.turnTraceCtx) {
      timingBreakdown = completeRealtimeVoiceTurn(this.turnTraceCtx, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
      traceId = this.turnTraceCtx.traceId;
      spanId = this.turnTraceCtx.spanId;
      recordRealtimeTurnComplete(
        this.config.sessionId,
        timingBreakdown.turnLatency,
        timingBreakdown.toolCallOverhead,
      );
      this.turnTraceCtx = null;
    }

    const turnMetrics: TurnMetrics = {
      turnId: this.currentTurnId || randomUUID(),
      durationMs: this.currentTurnStart ? Date.now() - this.currentTurnStart : 0,
      toolCalls: this.currentTurnToolCalls,
      toolCallLatencyMs: this.currentTurnToolLatency,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      timingBreakdown,
      traceId,
      spanId,
      semanticConvergence: this.buildSemanticTurnDiagnostics(),
    };

    // Reset turn tracking
    this.currentTurnId = null;
    this.currentTurnStart = null;
    this.currentTurnToolCalls = 0;
    this.currentTurnToolLatency = 0;
    this.latestFinalUserTranscript = null;
    this.currentTurnSawUserAudio = false;
    this.currentTurnCapturedFinalTranscript = false;
    this.currentTurnUsedCoordinatorTool = false;

    this.config.onTurnEnd?.(turnMetrics);
  };

  private handleError = (error: Error): void => {
    log.error('Realtime voice session error', {
      sessionId: this.config.sessionId,
      error: error.message,
    });
    this.config.onError?.(error);
  };

  private handleInterrupted = (): void => {
    if (this.turnTraceCtx) {
      failRealtimeVoiceTurn(this.turnTraceCtx, 'barge_in');
      this.turnTraceCtx = null;
    }
    recordRealtimeInterruption(this.config.sessionId);

    log.debug('Realtime voice interrupted (barge-in)', {
      sessionId: this.config.sessionId,
    });
  };

  private handleAudio = (audio: Buffer): void => {
    if (this.turnTraceCtx) {
      recordRealtimeFirstAudioOut(this.turnTraceCtx);
    }
    this.config.onAudio?.(audio);
  };

  private handleNormalizedEvent = (event: NormalizedVoiceEvent): void => {
    if (event.type === 'user_transcript_final') {
      const text = typeof event.payload.text === 'string' ? event.payload.text.trim() : '';
      if (text.length > 0) {
        this.ensureTurnTrackingStarted();
        this.latestFinalUserTranscript = text;
        this.currentTurnCapturedFinalTranscript = true;
      }
      return;
    }

    if (
      event.type === 'tool_call_requested' &&
      event.payload.name === REALTIME_VOICE_TURN_TOOL_NAME
    ) {
      this.currentTurnUsedCoordinatorTool = true;
    }
  };

  private handleConnectionStateChange = (state: RealtimeConnectionState): void => {
    log.info('Realtime voice connection state changed', {
      sessionId: this.config.sessionId,
      state,
    });
  };

  // ===========================================================================
  // PRIVATE — CONFIG BUILDING
  // ===========================================================================

  private buildSessionConfig(): RealtimeSessionConfig {
    const base = this.config.sessionConfig;
    const promptProfile = this.buildPromptProfile(this.agentIR);

    return {
      ...base,
      systemPrompt: promptProfile.systemPrompt,
      tools: promptProfile.tools,
    };
  }

  private buildPromptProfile(agentIR: AgentIR): VoicePromptProfileResult {
    const promptProfile = buildLiveVoicePromptSurface({
      sessionId: this.config.sessionId,
      agentIR,
      runtimeSession: this.config.runtimeSession,
      preferredProfile: 'realtime',
      providerCapabilityProfile: this.session.getCapabilityProfile(),
      semanticConvergencePlan: this.config.semanticConvergence,
    });

    this.promptProfileDiagnostics = promptProfile.diagnostics;

    log.debug('Resolved realtime voice prompt profile', {
      sessionId: this.config.sessionId,
      providerType: this.session.providerType,
      promptProfile: promptProfile.profile,
      promptRefresh: promptProfile.diagnostics.promptRefresh,
      toolRefresh: promptProfile.diagnostics.toolRefresh,
      usingRuntimeSession: promptProfile.diagnostics.usingRuntimeSession,
      semanticMode: promptProfile.diagnostics.semanticConvergenceMode,
      semanticStrategy: promptProfile.diagnostics.semanticStrategy,
      capabilityNotes: promptProfile.diagnostics.capabilityNotes,
    });

    return promptProfile;
  }

  private ensureTurnTrackingStarted(): void {
    if (this.currentTurnId) {
      return;
    }

    this.turnTraceCtx = startRealtimeVoiceTurn(this.config.sessionId);
    this.currentTurnId = this.turnTraceCtx.turnId;
    this.currentTurnStart = Date.now();
    this.currentTurnToolCalls = 0;
    this.currentTurnToolLatency = 0;
  }

  private resolveVoiceTurnUtterance(args: Record<string, unknown>): string {
    if (this.latestFinalUserTranscript?.trim()) {
      return this.latestFinalUserTranscript.trim();
    }

    const candidateKeys = ['utterance', 'transcript', 'message'];
    for (const key of candidateKeys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    return '';
  }

  private buildSemanticTurnDiagnostics(): RealtimeSemanticTurnDiagnostics | undefined {
    const plan = this.config.semanticConvergence;
    if (!plan || plan.mode === 'off') {
      return undefined;
    }

    const bypassDetected =
      plan.strategy === 'coordinator_tool' &&
      (this.currentTurnSawUserAudio || this.currentTurnCapturedFinalTranscript) &&
      !this.currentTurnUsedCoordinatorTool;

    if (bypassDetected) {
      const level = plan.mode === 'enforce' ? 'error' : 'warn';
      log[level]('Realtime voice turn bypassed canonical coordinator tool', {
        sessionId: this.config.sessionId,
        providerType: this.session.providerType,
        family: plan.family,
        mode: plan.mode,
      });
    }

    return {
      mode: plan.mode,
      strategy: plan.strategy,
      family: plan.family,
      providerType: this.session.providerType,
      reason: plan.reason,
      usedCoordinatorTool: this.currentTurnUsedCoordinatorTool,
      sawUserAudio: this.currentTurnSawUserAudio,
      capturedFinalTranscript: this.currentTurnCapturedFinalTranscript,
      bypassDetected,
    };
  }

  private getSemanticStrategy(): VoiceSemanticConvergenceStrategy {
    return this.config.semanticConvergence?.strategy ?? 'legacy';
  }
}

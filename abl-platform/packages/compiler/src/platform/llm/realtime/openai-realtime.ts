/**
 * OpenAI Realtime API Adapter
 *
 * WebSocket-based realtime voice session using OpenAI's Realtime API.
 * Supports:
 * - Native audio-in/audio-out (PCM16, g711_ulaw, g711_alaw)
 * - Server-side VAD with barge-in
 * - Tool calling via function_call events
 * - Session updates (system prompt, tools)
 * - Reconnection with exponential backoff
 */

import { createLogger } from '../../logger.js';
import type {
  NormalizedVoiceEvent,
  RealtimeVoiceSession,
  RealtimeVoiceSessionEvents,
  RealtimeSessionConfig,
  RealtimeConnectionState,
  RealtimeToolCall,
  RealtimeTranscript,
  RealtimeUsageMetrics,
  RealtimeProviderType,
  RealtimeVoiceProviderCapabilityProfile,
} from './types.js';
import type { ToolDefinition } from '../types.js';

const log = createLogger('openai-realtime');

const DEFAULT_MODEL = 'gpt-realtime-1.5';
const DEFAULT_ENDPOINT = 'wss://api.openai.com/v1/realtime';
const DEFAULT_AUDIO_FORMAT = 'pcm16';
const DEFAULT_SAMPLE_RATE = 24000;
const MAX_RECONNECT_RETRIES = 3;
const RECONNECT_BASE_DELAY_MS = 1000;

// =============================================================================
// OPENAI REALTIME EVENT TYPES
// =============================================================================

interface OpenAIRealtimeServerEvent {
  type: string;
  [key: string]: unknown;
}

const OPENAI_REALTIME_CAPABILITY_PROFILE = {
  providerType: 'openai_realtime',
  capabilities: {
    supportsPromptRefresh: true,
    supportsToolRefresh: true,
    supportsToolResultInjection: true,
    supportsPartialAssistantTranscript: true,
    supportsProviderTurnDetection: true,
    supportsBargeInSignal: true,
  },
  notes: [
    'Mid-session prompt and tool refresh use session.update on the provider socket.',
    'Tool results inject through conversation items and a follow-up response.create call.',
    'Assistant transcript deltas and provider speech-started signals are both surfaced.',
  ],
} as const satisfies RealtimeVoiceProviderCapabilityProfile;

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class OpenAIRealtimeSession implements RealtimeVoiceSession {
  readonly providerType: RealtimeProviderType = 'openai_realtime';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ws is dynamically imported at runtime
  private ws: any = null;
  private config: RealtimeSessionConfig | null = null;
  private _connectionState: RealtimeConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTime: number | null = null;
  private intentionalDisconnect = false;

  // Event handlers
  private handlers: {
    [K in keyof RealtimeVoiceSessionEvents]: Set<NonNullable<RealtimeVoiceSessionEvents[K]>>;
  } = {
    onAudio: new Set(),
    onTranscript: new Set(),
    onToolCall: new Set(),
    onTurnEnd: new Set(),
    onError: new Set(),
    onInterrupted: new Set(),
    onNormalizedEvent: new Set(),
    onConnectionStateChange: new Set(),
    onJoinUrl: new Set(),
  };

  // Usage tracking
  private usage: RealtimeUsageMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    audioDurationInMs: 0,
    audioDurationOutMs: 0,
    turnCount: 0,
    connectionDurationMs: 0,
  };

  get connectionState(): RealtimeConnectionState {
    return this._connectionState;
  }

  getCapabilityProfile(): RealtimeVoiceProviderCapabilityProfile {
    return OPENAI_REALTIME_CAPABILITY_PROFILE;
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this.config = config;
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;
    await this.establishConnection();
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.connectTime) {
      this.usage.connectionDurationMs += Date.now() - this.connectTime;
      this.connectTime = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === 0 /* CONNECTING */ || this.ws.readyState === 1 /* OPEN */) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }

    this.setConnectionState('disconnected');
  }

  // ===========================================================================
  // AUDIO
  // ===========================================================================

  sendAudio(audio: Buffer): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: audio.toString('base64'),
    });
  }

  commitAudioBuffer(): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    this.sendEvent({ type: 'input_audio_buffer.commit' });
  }

  cancelResponse(): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    this.sendEvent({ type: 'response.cancel' });
  }

  // ===========================================================================
  // TOOL RESULTS
  // ===========================================================================

  submitToolResult(callId: string, result: string): void {
    if (!this.ws || this._connectionState !== 'connected') return;

    // Add tool result as conversation item
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: result,
      },
    });

    // Trigger a new response after tool result
    this.sendEvent({ type: 'response.create' });
  }

  // ===========================================================================
  // SESSION UPDATES
  // ===========================================================================

  updateSystemPrompt(prompt: string): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    this.sendEvent({
      type: 'session.update',
      session: { instructions: prompt },
    });
  }

  updateTools(tools: ToolDefinition[]): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    this.sendEvent({
      type: 'session.update',
      session: {
        tools: tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    });
  }

  // ===========================================================================
  // EVENT HANDLERS
  // ===========================================================================

  on<K extends keyof RealtimeVoiceSessionEvents>(
    event: K,
    handler: NonNullable<RealtimeVoiceSessionEvents[K]>,
  ): void {
    (this.handlers[event] as Set<any>).add(handler);
  }

  off<K extends keyof RealtimeVoiceSessionEvents>(
    event: K,
    handler: NonNullable<RealtimeVoiceSessionEvents[K]>,
  ): void {
    (this.handlers[event] as Set<any>).delete(handler);
  }

  getUsageMetrics(): RealtimeUsageMetrics {
    const metrics = { ...this.usage };
    if (this.connectTime) {
      metrics.connectionDurationMs += Date.now() - this.connectTime;
    }
    return metrics;
  }

  // ===========================================================================
  // PRIVATE — CONNECTION
  // ===========================================================================

  private async establishConnection(): Promise<void> {
    if (!this.config) throw new Error('No config provided');

    this.setConnectionState('connecting');

    const model = this.config.model || DEFAULT_MODEL;
    const endpoint = this.config.endpoint || DEFAULT_ENDPOINT;
    const url = `${endpoint}?model=${encodeURIComponent(model)}`;

    try {
      // Dynamic import — ws is a runtime-only dependency (not in compiler's package.json).
      // Use createRequire anchored at cwd so it resolves from the host app's node_modules.
      const { createRequire } = await import('node:module');
      const _require = createRequire(process.cwd() + '/package.json');
      const wsModule = { default: _require('ws') };
      const WebSocket = wsModule.default || wsModule;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
        }, 15000);

        this.ws!.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.ws!.once('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      this.connectTime = Date.now();
      // NOTE: Do NOT reset reconnectAttempts here. If the server accepts the
      // WebSocket but immediately closes it (e.g. auth error), resetting here
      // causes an infinite reconnect loop. Reset in session.created handler.

      // Set up event listeners
      this.ws.on('message', (data: { toString(): string }) => this.handleMessage(data));
      this.ws.on('close', (code: number, reason: Buffer) =>
        this.handleClose(code, reason.toString()),
      );
      this.ws.on('error', (err: Error) => this.handleError(err));

      // Send initial session configuration
      this.sendSessionConfig();

      this.setConnectionState('connected');
      log.info('OpenAI Realtime connected', { model, endpoint: this.config.endpoint || 'default' });
    } catch (err) {
      log.error('OpenAI Realtime connection failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.setConnectionState('error');
      this.emit('onError', err as Error);

      if (!this.intentionalDisconnect) {
        this.attemptReconnect();
      }

      throw err;
    }
  }

  private sendSessionConfig(): void {
    if (!this.config || !this.ws) return;

    const session: Record<string, unknown> = {
      modalities: ['text', 'audio'],
      instructions: this.config.systemPrompt,
      voice: this.config.voice || 'marin',
      input_audio_format: this.config.audioFormat || DEFAULT_AUDIO_FORMAT,
      output_audio_format: this.config.audioFormat || DEFAULT_AUDIO_FORMAT,
    };

    if (this.config.temperature != null) {
      session.temperature = this.config.temperature;
    }

    if (this.config.maxResponseTokens != null) {
      session.max_response_output_tokens = this.config.maxResponseTokens;
    }

    if (this.config.turnDetection) {
      session.turn_detection = {
        type: this.config.turnDetection.type,
        ...(this.config.turnDetection.threshold != null && {
          threshold: this.config.turnDetection.threshold,
        }),
        ...(this.config.turnDetection.prefix_padding_ms != null && {
          prefix_padding_ms: this.config.turnDetection.prefix_padding_ms,
        }),
        ...(this.config.turnDetection.silence_duration_ms != null && {
          silence_duration_ms: this.config.turnDetection.silence_duration_ms,
        }),
      };
    } else {
      session.turn_detection = { type: 'server_vad' };
    }

    // Enable input audio transcription (required for user speech transcription)
    session.input_audio_transcription = { model: 'whisper-1' };

    if (this.config.tools?.length) {
      session.tools = this.config.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }));
    }

    log.debug('Sending session.update', {
      modalities: session.modalities,
      voice: session.voice,
      inputFormat: session.input_audio_format,
      outputFormat: session.output_audio_format,
      turnDetection: JSON.stringify(session.turn_detection),
      toolCount: (session.tools as unknown[])?.length || 0,
    });
    this.sendEvent({ type: 'session.update', session });
  }

  // ===========================================================================
  // PRIVATE — MESSAGE HANDLING
  // ===========================================================================

  private handleMessage(data: { toString(): string }): void {
    try {
      const event = JSON.parse(data.toString()) as OpenAIRealtimeServerEvent;
      this.routeServerEvent(event);
    } catch (err) {
      log.warn('Failed to parse realtime event', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private routeServerEvent(event: OpenAIRealtimeServerEvent): void {
    switch (event.type) {
      case 'session.created':
        this.reconnectAttempts = 0; // Reset only after server confirms session
        log.debug('OpenAI Realtime session created', { session: (event as any).session?.id });
        break;
      case 'session.updated':
        log.debug('OpenAI Realtime session updated');
        break;

      case 'response.audio.delta':
        this.handleAudioDelta(event);
        break;

      case 'response.audio_transcript.delta':
        this.handleTranscriptDelta(event);
        break;

      case 'response.audio_transcript.done':
        this.handleTranscriptDone(event);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.handleInputTranscript(event);
        break;

      case 'conversation.item.input_audio_transcription.delta':
        this.handleInputTranscriptDelta(event);
        break;

      case 'response.function_call_arguments.done':
        this.handleFunctionCall(event);
        break;

      case 'response.done':
        this.handleResponseDone(event);
        break;

      case 'input_audio_buffer.speech_started':
        this.emitNormalizedEvent({
          type: 'turn_interrupted',
          providerType: this.providerType,
          timestamp: Date.now(),
          payload: {
            rawEventType: event.type,
          },
        });
        this.emit('onInterrupted');
        break;

      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed':
      case 'conversation.item.created':
      case 'response.created':
      case 'response.output_item.added':
      case 'response.output_item.done':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.audio.done':
      case 'rate_limits.updated':
        // Informational lifecycle events — no action needed
        break;

      case 'error':
        this.handleServerError(event);
        break;

      default:
        log.debug('OpenAI Realtime event (unhandled)', { type: event.type });
        break;
    }
  }

  private handleAudioDelta(event: OpenAIRealtimeServerEvent): void {
    const audioBase64 = event.delta as string;
    if (!audioBase64) return;

    const audioBuffer = Buffer.from(audioBase64, 'base64');
    this.emit('onAudio', audioBuffer);
  }

  private handleTranscriptDelta(event: OpenAIRealtimeServerEvent): void {
    const text = event.delta as string;
    if (!text) return;

    const transcript: RealtimeTranscript = {
      text,
      role: 'assistant',
      isFinal: false,
    };
    this.emitNormalizedEvent({
      type: 'assistant_transcript_partial',
      providerType: this.providerType,
      timestamp: Date.now(),
      payload: {
        text,
        rawEventType: event.type,
      },
    });
    this.emit('onTranscript', transcript);
  }

  private handleTranscriptDone(event: OpenAIRealtimeServerEvent): void {
    const text = event.transcript as string;
    if (!text) return;

    const transcript: RealtimeTranscript = {
      text,
      role: 'assistant',
      isFinal: true,
    };
    this.emitNormalizedEvent({
      type: 'assistant_transcript_final',
      providerType: this.providerType,
      timestamp: Date.now(),
      payload: {
        text,
        rawEventType: event.type,
      },
    });
    this.emit('onTranscript', transcript);
  }

  private handleInputTranscript(event: OpenAIRealtimeServerEvent): void {
    const text = event.transcript as string;
    if (!text) return;

    const transcript: RealtimeTranscript = {
      text,
      role: 'user',
      isFinal: true,
    };
    this.emitNormalizedEvent({
      type: 'user_transcript_final',
      providerType: this.providerType,
      timestamp: Date.now(),
      payload: {
        text,
        rawEventType: event.type,
      },
    });
    this.emit('onTranscript', transcript);
  }

  private handleInputTranscriptDelta(event: OpenAIRealtimeServerEvent): void {
    const text = event.delta as string;
    if (!text) return;

    this.emitNormalizedEvent({
      type: 'user_transcript_partial',
      providerType: this.providerType,
      timestamp: Date.now(),
      payload: {
        text,
        rawEventType: event.type,
      },
    });
  }

  private handleFunctionCall(event: OpenAIRealtimeServerEvent): void {
    const toolCall: RealtimeToolCall = {
      callId: event.call_id as string,
      name: event.name as string,
      arguments: event.arguments as string,
    };
    this.emitNormalizedEvent({
      type: 'tool_call_requested',
      providerType: this.providerType,
      timestamp: Date.now(),
      payload: {
        callId: toolCall.callId,
        name: toolCall.name,
        arguments: toolCall.arguments,
        rawEventType: event.type,
      },
    });
    this.emit('onToolCall', toolCall);
  }

  private handleResponseDone(event: OpenAIRealtimeServerEvent): void {
    this.usage.turnCount++;

    const responseUsage = (event.response as any)?.usage;
    if (responseUsage) {
      this.usage.inputTokens += responseUsage.input_tokens || 0;
      this.usage.outputTokens += responseUsage.output_tokens || 0;
      this.usage.totalTokens += responseUsage.total_tokens || 0;
    }

    this.emit('onTurnEnd', {
      inputTokens: responseUsage?.input_tokens,
      outputTokens: responseUsage?.output_tokens,
      totalTokens: responseUsage?.total_tokens,
    });
    this.emitNormalizedEvent({
      type: 'turn_completed',
      providerType: this.providerType,
      timestamp: Date.now(),
      payload: {
        rawEventType: event.type,
        inputTokens: responseUsage?.input_tokens,
        outputTokens: responseUsage?.output_tokens,
        totalTokens: responseUsage?.total_tokens,
      },
    });
  }

  private handleServerError(event: OpenAIRealtimeServerEvent): void {
    const error = event.error as { message?: string; type?: string; code?: string } | undefined;
    const message = error?.message || 'Unknown realtime error';
    log.error('OpenAI Realtime server error', {
      error: message,
      type: error?.type,
      code: error?.code,
    });
    this.emitNormalizedEvent({
      type: 'provider_error',
      providerType: this.providerType,
      timestamp: Date.now(),
      payload: {
        message,
        errorType: error?.type,
        code: error?.code,
        rawEventType: event.type,
      },
    });
    this.emit('onError', new Error(message));
  }

  // ===========================================================================
  // PRIVATE — CONNECTION MANAGEMENT
  // ===========================================================================

  private handleClose(code: number, reason: string): void {
    log.info('OpenAI Realtime WebSocket closed', { code, reason });

    if (this.connectTime) {
      this.usage.connectionDurationMs += Date.now() - this.connectTime;
      this.connectTime = null;
    }

    if (!this.intentionalDisconnect && code !== 1000) {
      this.attemptReconnect();
    } else {
      this.setConnectionState('disconnected');
    }
  }

  private handleError(err: Error): void {
    log.error('OpenAI Realtime WebSocket error', { error: err.message });
    this.emit('onError', err);
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_RETRIES) {
      log.error('Max reconnection attempts reached');
      this.setConnectionState('error');
      this.emit('onError', new Error('Max reconnection attempts reached'));
      return;
    }

    this.setConnectionState('reconnecting');
    this.reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);

    log.info('Reconnecting', { attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.establishConnection();
      } catch {
        // establishConnection already handles retry scheduling
      }
    }, delay);
  }

  private setConnectionState(state: RealtimeConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    this.emit('onConnectionStateChange', state);
  }

  // ===========================================================================
  // PRIVATE — UTILITIES
  // ===========================================================================

  private sendEvent(event: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return;
    this.ws.send(JSON.stringify(event));
  }

  private emit<K extends keyof RealtimeVoiceSessionEvents>(
    event: K,
    ...args: Parameters<NonNullable<RealtimeVoiceSessionEvents[K]>>
  ): void {
    const handlers = this.handlers[event] as Set<(...a: any[]) => void>;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch (err) {
        log.warn('Event handler error', {
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private emitNormalizedEvent(event: NormalizedVoiceEvent): void {
    this.emit('onNormalizedEvent', event);
  }
}

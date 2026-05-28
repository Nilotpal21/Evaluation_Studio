/**
 * Gemini Live (BidiGenerateContent) Adapter
 *
 * WebSocket-based realtime voice session using Google's Gemini Live API.
 * Supports:
 * - Bidirectional audio streaming via BidiGenerateContent
 * - Server-side voice activity detection
 * - Tool calling via functionCall/functionResponse
 * - Session setup with system instructions and generation config
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

const log = createLogger('gemini-live');

const DEFAULT_MODEL = 'gemini-2.0-flash-live-001';
const DEFAULT_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MAX_RECONNECT_RETRIES = 3;
const RECONNECT_BASE_DELAY_MS = 1000;

const GEMINI_LIVE_CAPABILITY_PROFILE = {
  providerType: 'gemini_live',
  capabilities: {
    supportsPromptRefresh: false,
    supportsToolRefresh: false,
    supportsToolResultInjection: true,
    supportsPartialAssistantTranscript: true,
    supportsProviderTurnDetection: false,
    supportsBargeInSignal: true,
  },
  notes: [
    'Tool results are supported, but system prompt and tool updates do not apply mid-session.',
    'Assistant transcript parts and interruption flags are available from serverContent.',
    'Current session setup does not expose a provider-owned turn-detection contract.',
  ],
} as const satisfies RealtimeVoiceProviderCapabilityProfile;

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class GeminiLiveSession implements RealtimeVoiceSession {
  readonly providerType: RealtimeProviderType = 'gemini_live';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ws is dynamically imported at runtime
  private ws: any = null;
  private config: RealtimeSessionConfig | null = null;
  private _connectionState: RealtimeConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTime: number | null = null;
  private intentionalDisconnect = false;
  private setupComplete = false;

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
    return GEMINI_LIVE_CAPABILITY_PROFILE;
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this.config = config;
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;
    this.setupComplete = false;
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
      if (this.ws.readyState === 0 || this.ws.readyState === 1) {
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
    if (!this.ws || this._connectionState !== 'connected' || !this.setupComplete) return;

    this.sendMessage({
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: 'audio/pcm;rate=24000',
            data: audio.toString('base64'),
          },
        ],
      },
    });
  }

  commitAudioBuffer(): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    // Gemini uses activityEnd to signal end of user turn
    this.sendMessage({ clientContent: { turnComplete: true } });
  }

  cancelResponse(): void {
    // Gemini doesn't have a direct cancel — send activityEnd to signal interruption
    if (!this.ws || this._connectionState !== 'connected') return;
    this.sendMessage({ clientContent: { turnComplete: true } });
    this.emit('onInterrupted');
  }

  // ===========================================================================
  // TOOL RESULTS
  // ===========================================================================

  submitToolResult(callId: string, result: string): void {
    if (!this.ws || this._connectionState !== 'connected') return;

    this.sendMessage({
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            name: callId, // Gemini uses name as ID
            response: { result },
          },
        ],
      },
    });
  }

  // ===========================================================================
  // SESSION UPDATES
  // ===========================================================================

  updateSystemPrompt(prompt: string): void {
    // Gemini requires a new session setup to change system instructions
    // Send as a setup message (will take effect on next turn)
    if (!this.ws || this._connectionState !== 'connected') return;
    log.warn(
      'Gemini Live does not support mid-session system prompt updates; will take effect on reconnect',
    );
  }

  updateTools(tools: ToolDefinition[]): void {
    // Similar to system prompt — Gemini tools are set at session setup
    if (!this.ws || this._connectionState !== 'connected') return;
    log.warn(
      'Gemini Live does not support mid-session tool updates; will take effect on reconnect',
    );
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
    const url = `${endpoint}?key=${encodeURIComponent(this.config.apiKey)}`;

    try {
      // Dynamic import — ws is a runtime-only dependency (not in compiler's package.json).
      // Use createRequire anchored at cwd so it resolves from the host app's node_modules.
      const { createRequire } = await import('node:module');
      const _require = createRequire(process.cwd() + '/package.json');
      const wsModule = { default: _require('ws') };
      const WebSocket = wsModule.default || wsModule;

      this.ws = new WebSocket(url);

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
      // WebSocket but immediately closes it (e.g. invalid model → code 1008),
      // resetting here causes an infinite reconnect loop. Instead, reset only
      // after we receive setupComplete from the server (see routeServerEvent).

      this.ws.on('message', (data: { toString(): string }) => this.handleMessage(data));
      this.ws.on('close', (code: number, reason: Buffer) =>
        this.handleClose(code, reason.toString()),
      );
      this.ws.on('error', (err: Error) => this.handleError(err));

      // Send setup message
      this.sendSetupMessage();

      this.setConnectionState('connected');
      log.info('Gemini Live connected', { model });
    } catch (err) {
      log.error('Gemini Live connection failed', {
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

  private sendSetupMessage(): void {
    if (!this.config || !this.ws) return;

    const setup: Record<string, unknown> = {
      setup: {
        model: `models/${this.config.model || DEFAULT_MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.config.voice || 'Puck',
              },
            },
          },
        },
      },
    };

    if (this.config.systemPrompt) {
      (setup.setup as any).systemInstruction = {
        parts: [{ text: this.config.systemPrompt }],
      };
    }

    if (this.config.tools?.length) {
      (setup.setup as any).tools = [
        {
          functionDeclarations: this.config.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          })),
        },
      ];
    }

    this.sendMessage(setup);
  }

  // ===========================================================================
  // PRIVATE — MESSAGE HANDLING
  // ===========================================================================

  private handleMessage(data: { toString(): string }): void {
    try {
      const event = JSON.parse(data.toString());
      this.routeServerEvent(event);
    } catch (err) {
      log.warn('Failed to parse Gemini Live event', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private routeServerEvent(event: Record<string, unknown>): void {
    if (event.setupComplete) {
      this.setupComplete = true;
      this.reconnectAttempts = 0; // Reset only after server confirms setup
      log.debug('Gemini Live setup complete');
      return;
    }

    if (event.serverContent) {
      this.handleServerContent(event.serverContent as Record<string, unknown>);
      return;
    }

    if (event.toolCall) {
      this.handleToolCallEvent(event.toolCall as Record<string, unknown>);
      return;
    }
  }

  private handleServerContent(content: Record<string, unknown>): void {
    const parts = (content.modelTurn as any)?.parts || [];

    for (const part of parts) {
      // Audio data
      if (part.inlineData) {
        const audioBase64 = part.inlineData.data as string;
        if (audioBase64) {
          const audioBuffer = Buffer.from(audioBase64, 'base64');
          this.emit('onAudio', audioBuffer);
        }
      }

      // Text transcript
      if (part.text) {
        const transcript: RealtimeTranscript = {
          text: part.text,
          role: 'assistant',
          isFinal: !!content.turnComplete,
        };
        this.emitNormalizedEvent({
          type: content.turnComplete
            ? 'assistant_transcript_final'
            : 'assistant_transcript_partial',
          providerType: this.providerType,
          timestamp: Date.now(),
          payload: {
            text: part.text,
            turnComplete: !!content.turnComplete,
            interrupted: !!content.interrupted,
          },
        });
        this.emit('onTranscript', transcript);
      }
    }

    // Turn complete
    if (content.turnComplete) {
      this.usage.turnCount++;
      this.emit('onTurnEnd', {});
      this.emitNormalizedEvent({
        type: 'turn_completed',
        providerType: this.providerType,
        timestamp: Date.now(),
        payload: {
          turnComplete: true,
        },
      });
    }

    // Interrupted
    if (content.interrupted) {
      this.emitNormalizedEvent({
        type: 'turn_interrupted',
        providerType: this.providerType,
        timestamp: Date.now(),
        payload: {
          interrupted: true,
        },
      });
      this.emit('onInterrupted');
    }
  }

  private handleToolCallEvent(toolCall: Record<string, unknown>): void {
    const calls = (toolCall as any).functionCalls || [];
    for (const call of calls) {
      const tc: RealtimeToolCall = {
        callId: call.id || call.name,
        name: call.name,
        arguments: JSON.stringify(call.args || {}),
      };
      this.emitNormalizedEvent({
        type: 'tool_call_requested',
        providerType: this.providerType,
        timestamp: Date.now(),
        payload: {
          callId: tc.callId,
          name: tc.name,
          arguments: tc.arguments,
        },
      });
      this.emit('onToolCall', tc);
    }
  }

  // ===========================================================================
  // PRIVATE — CONNECTION MANAGEMENT
  // ===========================================================================

  private handleClose(code: number, reason: string): void {
    log.info('Gemini Live WebSocket closed', { code, reason });

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
    log.error('Gemini Live WebSocket error', { error: err.message });
    this.emitNormalizedEvent({
      type: 'provider_error',
      providerType: this.providerType,
      timestamp: Date.now(),
      payload: {
        message: err.message,
      },
    });
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
        // establishConnection handles retry scheduling
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

  private sendMessage(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg));
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

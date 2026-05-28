/**
 * Ultravox Realtime Voice Adapter
 *
 * REST-based realtime voice session using the Ultravox API.
 * Unlike OpenAI/Gemini which maintain server-side WebSocket connections,
 * Ultravox uses a 2-step model:
 *   1. Server creates a call via POST /api/calls → returns a joinUrl
 *   2. Client (browser) connects to the joinUrl using the Ultravox Client SDK
 *
 * Audio streaming happens directly between the client and Ultravox — our server
 * only handles REST API orchestration and status polling.
 */

import { createLogger } from '../../logger.js';
import type {
  NormalizedVoiceEvent,
  RealtimeVoiceSession,
  RealtimeVoiceSessionEvents,
  RealtimeSessionConfig,
  RealtimeConnectionState,
  RealtimeUsageMetrics,
  RealtimeProviderType,
  RealtimeTurnDetection,
  RealtimeVoiceProviderCapabilityProfile,
} from './types.js';
import type { ToolDefinition } from '../types.js';

const log = createLogger('ultravox-realtime');

const ULTRAVOX_API_BASE = 'https://api.ultravox.ai/api';
const DEFAULT_VOICE = 'Tanya-English';
const DEFAULT_JOIN_TIMEOUT = '30s';
const DEFAULT_MAX_DURATION = '3600s';
const STATUS_POLL_INTERVAL_MS = 5000;

const ULTRAVOX_CAPABILITY_PROFILE = {
  providerType: 'ultravox',
  capabilities: {
    supportsPromptRefresh: false,
    supportsToolRefresh: false,
    supportsToolResultInjection: false,
    supportsPartialAssistantTranscript: false,
    supportsProviderTurnDetection: true,
    supportsBargeInSignal: false,
  },
  notes: [
    'System prompt and tools are fixed at call creation time.',
    'Server-side tool-result injection is not available because tool handling stays client-side.',
    'Ultravox accepts VAD settings at call creation, but the runtime does not receive transcript deltas.',
  ],
} as const satisfies RealtimeVoiceProviderCapabilityProfile;

// Ultravox call statuses that indicate the call has ended
const TERMINAL_STATUSES = new Set(['ended', 'error', 'timeout', 'cancelled']);

// =============================================================================
// ULTRAVOX API TYPES
// =============================================================================

interface UltravoxCallResponse {
  callId: string;
  joinUrl: string;
  created: string;
  ended?: string;
  model: string;
  systemPrompt?: string;
  languageHint?: string;
  voice?: string;
}

interface UltravoxCallStatus {
  callId: string;
  status: string;
  ended?: string;
  errorMessage?: string;
}

interface UltravoxTemporaryTool {
  temporaryTool: {
    modelToolName: string;
    description: string;
    dynamicParameters: Array<{
      name: string;
      location: 'PARAMETER_LOCATION_BODY';
      schema: Record<string, unknown>;
      required: boolean;
    }>;
  };
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class UltravoxRealtimeSession implements RealtimeVoiceSession {
  readonly providerType: RealtimeProviderType = 'ultravox';

  private config: RealtimeSessionConfig | null = null;
  private callId: string | null = null;
  private _connectionState: RealtimeConnectionState = 'disconnected';
  private connectTime: number | null = null;
  private statusPollTimer: ReturnType<typeof setInterval> | null = null;

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
    return ULTRAVOX_CAPABILITY_PROFILE;
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this.config = config;

    this.setConnectionState('connecting');

    const endpoint = config.endpoint || ULTRAVOX_API_BASE;
    const url = `${endpoint}/calls`;

    const body = this.buildCallPayload(config);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': config.apiKey,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ultravox API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as UltravoxCallResponse;
      this.callId = data.callId;
      this.connectTime = Date.now();

      log.info('Ultravox call created', {
        callId: this.callId,
        model: config.model,
        voice: config.voice || DEFAULT_VOICE,
      });

      this.setConnectionState('connected');

      // Emit the joinUrl so the runtime can forward it to the client
      this.emit('onJoinUrl', data.joinUrl);

      // Start polling call status to detect end/errors
      this.startStatusPolling(endpoint);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Ultravox call creation failed', { error: message });
      this.setConnectionState('error');
      this.emitNormalizedEvent({
        type: 'provider_error',
        providerType: this.providerType,
        timestamp: Date.now(),
        payload: {
          message,
          phase: 'connect',
        },
      });
      this.emit('onError', err instanceof Error ? err : new Error(message));
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.stopStatusPolling();

    if (this.connectTime) {
      this.usage.connectionDurationMs += Date.now() - this.connectTime;
      this.connectTime = null;
    }

    if (this.callId && this.config) {
      const endpoint = this.config.endpoint || ULTRAVOX_API_BASE;
      try {
        const response = await fetch(`${endpoint}/calls/${this.callId}`, {
          method: 'DELETE',
          headers: {
            'X-API-Key': this.config.apiKey,
          },
        });
        if (!response.ok) {
          log.warn('Ultravox call deletion returned non-OK status', {
            callId: this.callId,
            status: response.status,
          });
        } else {
          log.info('Ultravox call deleted', { callId: this.callId });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Failed to delete Ultravox call', {
          callId: this.callId,
          error: message,
        });
      }
    }

    this.callId = null;
    this.setConnectionState('disconnected');
  }

  // ===========================================================================
  // AUDIO — No-ops for Ultravox (audio is client↔Ultravox directly)
  // ===========================================================================

  sendAudio(_audio: Buffer): void {
    log.debug('sendAudio is a no-op for Ultravox — audio streams client-side via the Ultravox SDK');
  }

  commitAudioBuffer(): void {
    log.debug(
      'commitAudioBuffer is a no-op for Ultravox — audio streams client-side via the Ultravox SDK',
    );
  }

  cancelResponse(): void {
    log.debug('cancelResponse is not supported for Ultravox REST-based sessions');
  }

  // ===========================================================================
  // TOOL RESULTS — forwarded via REST (not applicable for server-side)
  // ===========================================================================

  submitToolResult(_callId: string, _result: string): void {
    log.debug(
      'submitToolResult is handled client-side via the Ultravox SDK — server cannot forward tool results',
    );
  }

  // ===========================================================================
  // SESSION UPDATES
  // ===========================================================================

  updateSystemPrompt(_prompt: string): void {
    log.debug(
      'updateSystemPrompt is not supported mid-call for Ultravox — system prompt is set at call creation',
    );
  }

  updateTools(_tools: ToolDefinition[]): void {
    log.debug(
      'updateTools is not supported mid-call for Ultravox — tools are set at call creation',
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
  // PRIVATE — CALL PAYLOAD
  // ===========================================================================

  private buildCallPayload(config: RealtimeSessionConfig): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: config.model || 'fixie-ai/ultravox',
      systemPrompt: config.systemPrompt,
      voice: config.voice || DEFAULT_VOICE,
      temperature: config.temperature ?? 0.5,
      joinTimeout: config.joinTimeout || DEFAULT_JOIN_TIMEOUT,
      maxDuration: config.maxDuration || DEFAULT_MAX_DURATION,
      recordingEnabled: config.recordingEnabled ?? false,
    };

    if (config.languageHint) {
      payload.languageHint = config.languageHint;
    }

    if (config.timeExceededMessage) {
      payload.timeExceededMessage = config.timeExceededMessage;
    }

    if (config.inactivityMessage) {
      payload.inactivityMessages = [{ duration: '30s', message: config.inactivityMessage }];
    }

    // First speaker settings
    if (config.firstSpeaker) {
      const firstSpeakerSettings: Record<string, unknown> = {
        user: config.firstSpeaker === 'user' ? {} : undefined,
        agent: config.firstSpeaker === 'agent' ? {} : undefined,
      };

      if (config.firstSpeaker === 'agent' && config.firstSpeakerMessage) {
        firstSpeakerSettings.agent = { uninterruptible: false };
      }

      payload.firstSpeakerSettings = firstSpeakerSettings;
    }

    // VAD settings
    if (config.turnDetection) {
      payload.vadSettings = this.buildVadSettings(config.turnDetection);
    }

    // Tools
    if (config.tools?.length) {
      payload.selectedTools = config.tools.map((t) => this.convertTool(t));
    }

    return payload;
  }

  private buildVadSettings(td: RealtimeTurnDetection): Record<string, unknown> {
    const vad: Record<string, unknown> = {};

    if (td.turnEndpointDelay) {
      vad.turnEndpointDelay = td.turnEndpointDelay;
    }
    if (td.minimumTurnDuration) {
      vad.minimumTurnDuration = td.minimumTurnDuration;
    }
    if (td.minimumInterruptionDuration) {
      vad.minimumInterruptionDuration = td.minimumInterruptionDuration;
    }
    if (td.frameActivationThreshold != null) {
      vad.frameActivationThreshold = td.frameActivationThreshold;
    }

    return vad;
  }

  // ===========================================================================
  // PRIVATE — TOOL CONVERSION
  // ===========================================================================

  /**
   * Convert a platform ToolDefinition to Ultravox's temporaryTool format.
   */
  private convertTool(tool: ToolDefinition): UltravoxTemporaryTool {
    const dynamicParameters = Object.entries(tool.input_schema.properties || {}).map(
      ([name, schema]) => ({
        name,
        location: 'PARAMETER_LOCATION_BODY' as const,
        schema: schema as unknown as Record<string, unknown>,
        required: tool.input_schema.required?.includes(name) ?? false,
      }),
    );

    return {
      temporaryTool: {
        modelToolName: tool.name,
        description: tool.description,
        dynamicParameters,
      },
    };
  }

  // ===========================================================================
  // PRIVATE — STATUS POLLING
  // ===========================================================================

  private startStatusPolling(endpoint: string): void {
    this.statusPollTimer = setInterval(() => {
      this.pollCallStatus(endpoint).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Status poll failed', { callId: this.callId, error: message });
      });
    }, STATUS_POLL_INTERVAL_MS);
  }

  private stopStatusPolling(): void {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  private async pollCallStatus(endpoint: string): Promise<void> {
    if (!this.callId || !this.config) return;

    try {
      const response = await fetch(`${endpoint}/calls/${this.callId}`, {
        method: 'GET',
        headers: {
          'X-API-Key': this.config.apiKey,
        },
      });

      if (!response.ok) {
        log.warn('Status poll returned non-OK', {
          callId: this.callId,
          status: response.status,
        });
        return;
      }

      const data = (await response.json()) as UltravoxCallStatus;

      if (TERMINAL_STATUSES.has(data.status)) {
        log.info('Ultravox call ended', {
          callId: this.callId,
          status: data.status,
          ...(data.errorMessage && { error: data.errorMessage }),
        });

        this.stopStatusPolling();

        if (this.connectTime) {
          this.usage.connectionDurationMs += Date.now() - this.connectTime;
          this.connectTime = null;
        }

        if (data.status === 'error') {
          this.setConnectionState('error');
          this.emitNormalizedEvent({
            type: 'provider_error',
            providerType: this.providerType,
            timestamp: Date.now(),
            payload: {
              status: data.status,
              message: data.errorMessage || 'Ultravox call ended with error',
            },
          });
          this.emit('onError', new Error(data.errorMessage || 'Ultravox call ended with error'));
        } else {
          this.setConnectionState('disconnected');
          this.emitNormalizedEvent({
            type: 'turn_completed',
            providerType: this.providerType,
            timestamp: Date.now(),
            payload: {
              status: data.status,
              ended: data.ended,
              partialLifecycle: true,
            },
          });
        }

        this.callId = null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Status poll request failed', { callId: this.callId, error: message });
    }
  }

  // ===========================================================================
  // PRIVATE — UTILITIES
  // ===========================================================================

  private setConnectionState(state: RealtimeConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    this.emit('onConnectionStateChange', state);
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
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Event handler error', { event, error: message });
      }
    }
  }

  private emitNormalizedEvent(event: NormalizedVoiceEvent): void {
    this.emit('onNormalizedEvent', event);
  }
}

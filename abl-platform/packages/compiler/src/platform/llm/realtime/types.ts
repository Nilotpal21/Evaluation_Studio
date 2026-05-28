/**
 * Realtime Voice LLM Types
 *
 * Core types for realtime voice LLM providers (OpenAI Realtime, Gemini Live).
 * These providers maintain persistent WebSocket sessions with native audio I/O,
 * unlike the request/response model of standard LLM providers.
 */

import type { ToolDefinition } from '../types.js';

// =============================================================================
// PROVIDER TYPES
// =============================================================================

export type RealtimeProviderType = 'openai_realtime' | 'gemini_live' | 'ultravox';

export type RealtimeAudioFormat = 'pcm16' | 'g711_ulaw' | 'g711_alaw';

export type RealtimeConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface RealtimeVoiceProviderCapabilities {
  supportsPromptRefresh: boolean;
  supportsToolRefresh: boolean;
  supportsToolResultInjection: boolean;
  supportsPartialAssistantTranscript: boolean;
  supportsProviderTurnDetection: boolean;
  supportsBargeInSignal: boolean;
}

export type RealtimeVoiceCapabilityKey = keyof RealtimeVoiceProviderCapabilities;

export interface RealtimeVoiceProviderCapabilityProfile {
  providerType: RealtimeProviderType;
  capabilities: RealtimeVoiceProviderCapabilities;
  notes: readonly string[];
}

export type NormalizedVoiceEventType =
  | 'user_transcript_partial'
  | 'user_transcript_final'
  | 'assistant_transcript_partial'
  | 'assistant_transcript_final'
  | 'tool_call_requested'
  | 'turn_interrupted'
  | 'turn_completed'
  | 'provider_error';

export interface NormalizedVoiceEvent {
  type: NormalizedVoiceEventType;
  providerType: RealtimeProviderType;
  timestamp: number;
  payload: Record<string, unknown>;
}

// =============================================================================
// SESSION CONFIG
// =============================================================================

export interface RealtimeTurnDetection {
  type: 'server_vad' | 'none';
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;

  // Ultravox VAD fields
  turnEndpointDelay?: string;
  minimumTurnDuration?: string;
  minimumInterruptionDuration?: string;
  frameActivationThreshold?: number;
}

export interface RealtimeSessionConfig {
  model: string;
  systemPrompt: string;
  tools?: ToolDefinition[];
  voice?: string;
  turnDetection?: RealtimeTurnDetection;
  audioFormat?: RealtimeAudioFormat;
  sampleRate?: number;
  temperature?: number;
  maxResponseTokens?: number;
  apiKey: string;
  endpoint?: string;

  // Ultravox-specific fields
  joinTimeout?: string;
  maxDuration?: string;
  languageHint?: string;
  firstSpeaker?: 'agent' | 'user';
  firstSpeakerMessage?: string;
  recordingEnabled?: boolean;
  inactivityMessage?: string;
  timeExceededMessage?: string;
}

// =============================================================================
// EVENTS
// =============================================================================

export interface RealtimeToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface RealtimeTranscript {
  text: string;
  role: 'user' | 'assistant';
  isFinal: boolean;
}

export interface RealtimeUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  audioDurationInMs: number;
  audioDurationOutMs: number;
  turnCount: number;
  connectionDurationMs: number;
}

// =============================================================================
// SESSION INTERFACE
// =============================================================================

export interface RealtimeVoiceSessionEvents {
  onAudio?: (audio: Buffer) => void;
  onTranscript?: (transcript: RealtimeTranscript) => void;
  onToolCall?: (toolCall: RealtimeToolCall) => void;
  onTurnEnd?: (usage: Partial<RealtimeUsageMetrics>) => void;
  onError?: (error: Error) => void;
  onInterrupted?: () => void;
  onNormalizedEvent?: (event: NormalizedVoiceEvent) => void;
  onConnectionStateChange?: (state: RealtimeConnectionState) => void;
  onJoinUrl?: (joinUrl: string) => void;
}

export interface RealtimeVoiceSession {
  readonly providerType: RealtimeProviderType;
  readonly connectionState: RealtimeConnectionState;

  getCapabilityProfile(): RealtimeVoiceProviderCapabilityProfile;

  connect(config: RealtimeSessionConfig): Promise<void>;
  disconnect(): Promise<void>;

  sendAudio(audio: Buffer): void;
  commitAudioBuffer(): void;
  cancelResponse(): void;

  submitToolResult(callId: string, result: string): void;

  updateSystemPrompt(prompt: string): void;
  updateTools(tools: ToolDefinition[]): void;

  on<K extends keyof RealtimeVoiceSessionEvents>(
    event: K,
    handler: NonNullable<RealtimeVoiceSessionEvents[K]>,
  ): void;

  off<K extends keyof RealtimeVoiceSessionEvents>(
    event: K,
    handler: NonNullable<RealtimeVoiceSessionEvents[K]>,
  ): void;

  getUsageMetrics(): RealtimeUsageMetrics;
}

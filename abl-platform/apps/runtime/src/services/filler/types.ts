/** Operation categories that drive which message pool is used */
export type StatusOperation =
  | 'tool_call'
  | 'reasoning'
  | 'handoff'
  | 'delegation'
  | 'extraction'
  | 'constraint_check'
  | 'general';

/** Source quality for a filler/status message candidate. */
export type FillerSource = 'pipeline' | 'piggybacked' | 'static';

/** A status event emitted to the client */
export interface StatusEvent {
  /** Unique event ID */
  id: string;
  /** Session this event belongs to */
  sessionId: string;
  /** Human-readable status text */
  text: string;
  /** What operation triggered this status */
  operation: StatusOperation;
  /** Which source produced the final status text */
  source: FillerSource;
  /** Whether this is transient (not persisted to history) */
  transient: true;
  /** Sequential index within this execution turn */
  index: number;
  /** Timestamp */
  timestamp: number;
}

/** Configuration for the filler service */
export interface FillerConfig {
  /** Whether fillers are enabled */
  enabled: boolean;
  /** Delay before emitting a filler (ms) — chat channels */
  chatDelayMs: number;
  /**
   * Delay before emitting a filler (ms) — voice pipeline channels.
   * When present, takes precedence over chatDelayMs for the static filler delay gate.
   * Voice pipeline channels use a shorter default than chat to keep TTS turns responsive.
   */
  voiceDelayMs?: number;
  /** Minimum interval between consecutive filler emissions (ms) */
  cooldownMs: number;
  /** Maximum fillers per execution turn */
  maxPerTurn: number;
}

export type FillerModelSource = 'system' | 'project' | 'tenant' | 'default';

export interface FillerPromptRef {
  promptId: string;
  versionId: string;
  promptName?: string;
  versionNumber?: number;
}

export interface ProjectFillerConfig {
  enabled?: boolean;
  chatEnabled?: boolean;
  voiceEnabled?: boolean;
  chatDelayMs?: number;
  voiceDelayMs?: number;
  cooldownMs?: number;
  maxPerTurn?: number;
  piggybackEnabled?: boolean;
  pipelineGenerationEnabled?: boolean;
  modelSource?: FillerModelSource;
  modelId?: string;
  tenantModelId?: string;
  promptRef?: FillerPromptRef;
}

export interface ResolvedFillerRuntimeConfig {
  serviceConfig: FillerConfig;
  piggybackEnabled: boolean;
  pipelineGenerationEnabled: boolean;
  modelSource: FillerModelSource;
  modelId?: string;
  tenantModelId?: string;
  promptRef?: FillerPromptRef;
}

/** Default configuration for chat channels */
export const DEFAULT_FILLER_CONFIG: Readonly<FillerConfig> = Object.freeze({
  enabled: true,
  chatDelayMs: 1200,
  cooldownMs: 3000,
  maxPerTurn: 5,
});

/** Default configuration for voice pipeline channels (korevg, voice_pipeline, audiocodes, etc.) */
export const DEFAULT_VOICE_PIPELINE_FILLER_CONFIG: Readonly<FillerConfig> = Object.freeze({
  enabled: true,
  chatDelayMs: 1200,
  voiceDelayMs: 500,
  cooldownMs: 5000,
  maxPerTurn: 3,
});

export const DEFAULT_FILLER_RUNTIME_CONFIG: ResolvedFillerRuntimeConfig = {
  serviceConfig: { ...DEFAULT_FILLER_CONFIG },
  piggybackEnabled: true,
  pipelineGenerationEnabled: true,
  modelSource: 'system',
};

/** A filler waiting in the queue */
export interface QueuedFiller {
  text: string;
  source: FillerSource;
  operation: StatusOperation;
  queuedAt: number;
  timerId: ReturnType<typeof setTimeout> | null;
}

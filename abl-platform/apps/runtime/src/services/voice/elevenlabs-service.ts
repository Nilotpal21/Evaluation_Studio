/**
 * ElevenLabs Service - Text-to-Speech
 *
 * Handles streaming TTS using ElevenLabs API.
 */

import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../../config/index.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

const log = createLogger('elevenlabs-service');

/** Maximum time to wait for initial ElevenLabs API response (ms) */
const ELEVENLABS_FETCH_TIMEOUT_MS = 15_000;

/** Maximum time to wait between stream chunks before considering it stalled (ms) */
const ELEVENLABS_CHUNK_TIMEOUT_MS = 10_000;

// =============================================================================
// TYPES
// =============================================================================

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
}

export interface SynthesisOptions {
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
  outputFormat?:
    | 'mp3_44100_128'
    | 'mp3_22050_32'
    | 'pcm_16000'
    | 'pcm_22050'
    | 'pcm_24000'
    | 'pcm_44100'
    | 'ulaw_8000';
  /** External abort signal for cooperative cancellation */
  signal?: AbortSignal;
}

export interface Voice {
  voiceId: string;
  name: string;
  category: string;
  description: string;
}

function readNumber(config: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = config?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readBoolean(
  config: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = config?.[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function buildVoiceSettings(
  config: Partial<
    Pick<SynthesisOptions, 'stability' | 'similarityBoost' | 'style' | 'useSpeakerBoost' | 'speed'>
  >,
): Required<
  Pick<SynthesisOptions, 'stability' | 'similarityBoost' | 'style' | 'useSpeakerBoost' | 'speed'>
> {
  return {
    stability: config.stability ?? 0.5,
    similarityBoost: config.similarityBoost ?? 0.75,
    style: config.style ?? 0,
    useSpeakerBoost: config.useSpeakerBoost ?? true,
    speed: config.speed ?? 1,
  };
}

// =============================================================================
// ELEVENLABS SERVICE
// =============================================================================

export class ElevenLabsService {
  private apiKey: string | null = null;
  private defaultVoiceId: string;
  private defaultModelId: string;
  private defaultVoiceSettings: Required<
    Pick<SynthesisOptions, 'stability' | 'similarityBoost' | 'style' | 'useSpeakerBoost' | 'speed'>
  >;
  private baseUrl = 'https://api.elevenlabs.io/v1';

  constructor(explicitConfig?: ElevenLabsConfig) {
    if (explicitConfig) {
      this.apiKey = explicitConfig.apiKey;
      this.defaultVoiceId = explicitConfig.voiceId || '21m00Tcm4TlvDq8ikWAM';
      this.defaultModelId = explicitConfig.modelId || 'eleven_turbo_v2_5';
      this.defaultVoiceSettings = buildVoiceSettings(explicitConfig);
      log.info('ElevenLabs configured with explicit credentials');
    } else {
      const el = getConfig().voice.elevenLabs;
      this.apiKey = el.apiKey || null;
      this.defaultVoiceId = el.voiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel
      this.defaultModelId = el.model || 'eleven_turbo_v2_5'; // Fastest model
      this.defaultVoiceSettings = buildVoiceSettings({});
      if (this.apiKey) {
        log.info('ElevenLabs API key configured');
      } else {
        log.warn('ElevenLabs API key not configured - TTS will be disabled');
      }
    }
  }

  /**
   * Create from a decrypted TenantServiceInstance.
   */
  static fromCredentials(apiKey: string, config?: Record<string, unknown>): ElevenLabsService {
    return new ElevenLabsService({
      apiKey,
      voiceId: (config?.voiceId as string) || undefined,
      modelId: (config?.model as string) || undefined,
      stability: readNumber(config, 'stability'),
      similarityBoost: readNumber(config, 'similarityBoost'),
      style: readNumber(config, 'style'),
      useSpeakerBoost: readBoolean(config, 'useSpeakerBoost'),
      speed: readNumber(config, 'speed'),
    });
  }

  /**
   * Check if ElevenLabs is configured
   */
  isConfigured(): boolean {
    return this.apiKey !== null;
  }

  /**
   * Synthesize text to speech (streaming)
   */
  async *synthesizeStream(text: string, options?: SynthesisOptions): AsyncGenerator<Uint8Array> {
    if (!this.apiKey) {
      throw new AppError('ElevenLabs not configured', { ...ErrorCodes.SERVICE_UNAVAILABLE });
    }

    const voiceId = options?.voiceId || this.defaultVoiceId;
    const modelId = options?.modelId || this.defaultModelId;
    const outputFormat = options?.outputFormat || 'ulaw_8000'; // Best for Twilio

    const url = `${this.baseUrl}/text-to-speech/${voiceId}/stream?output_format=${outputFormat}`;

    log.debug('Starting TTS synthesis', { voiceId, modelId, textLength: text.length });

    // AbortController for fetch timeout + external cancellation
    const controller = new AbortController();
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const fetchTimeout = setTimeout(() => controller.abort(), ELEVENLABS_FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: options?.stability ?? this.defaultVoiceSettings.stability,
            similarity_boost: options?.similarityBoost ?? this.defaultVoiceSettings.similarityBoost,
            style: options?.style ?? this.defaultVoiceSettings.style,
            use_speaker_boost:
              options?.useSpeakerBoost ?? this.defaultVoiceSettings.useSpeakerBoost,
            speed: options?.speed ?? this.defaultVoiceSettings.speed,
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(fetchTimeout);
    } catch (err) {
      clearTimeout(fetchTimeout);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new AppError('ElevenLabs fetch timed out', {
          ...ErrorCodes.SERVICE_UNAVAILABLE,
        });
      }
      throw err;
    }

    if (!response.ok) {
      const error = await response.text();
      throw new AppError(`ElevenLabs API error: ${response.status} - ${error}`, {
        ...ErrorCodes.SERVICE_UNAVAILABLE,
      });
    }

    if (!response.body) {
      throw new AppError('No response body from ElevenLabs', { ...ErrorCodes.INTERNAL_ERROR });
    }

    const reader = response.body.getReader();

    try {
      while (true) {
        let chunkTimer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          chunkTimer = setTimeout(
            () =>
              reject(
                new AppError('ElevenLabs stream chunk timed out', {
                  ...ErrorCodes.SERVICE_UNAVAILABLE,
                }),
              ),
            ELEVENLABS_CHUNK_TIMEOUT_MS,
          );
        });
        // Intentional: prevent unhandled rejection when reader.read() wins the race
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        timeoutPromise.catch(() => {});

        const chunkResult = await Promise.race([reader.read(), timeoutPromise]);
        clearTimeout(chunkTimer);
        if (chunkResult.done) break;
        yield chunkResult.value;
      }
    } finally {
      reader.releaseLock();
    }

    log.debug('TTS synthesis complete');
  }

  /**
   * Synthesize text to speech (full buffer)
   */
  async synthesize(text: string, options?: SynthesisOptions): Promise<Buffer> {
    const chunks: Uint8Array[] = [];

    for await (const chunk of this.synthesizeStream(text, options)) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  /**
   * Get available voices
   */
  async getVoices(): Promise<Voice[]> {
    if (!this.apiKey) {
      throw new AppError('ElevenLabs not configured', { ...ErrorCodes.SERVICE_UNAVAILABLE });
    }

    const response = await fetch(`${this.baseUrl}/voices`, {
      headers: {
        'xi-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new AppError(`ElevenLabs API error: ${response.status}`, {
        ...ErrorCodes.SERVICE_UNAVAILABLE,
      });
    }

    const data: any = await response.json();

    return data.voices.map(
      (v: { voice_id: string; name: string; category: string; description: string }) => ({
        voiceId: v.voice_id,
        name: v.name,
        category: v.category,
        description: v.description,
      }),
    );
  }

  /**
   * Get user subscription info
   */
  async getSubscription(): Promise<{
    characterCount: number;
    characterLimit: number;
    tier: string;
  }> {
    if (!this.apiKey) {
      throw new AppError('ElevenLabs not configured', { ...ErrorCodes.SERVICE_UNAVAILABLE });
    }

    const response = await fetch(`${this.baseUrl}/user/subscription`, {
      headers: {
        'xi-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new AppError(`ElevenLabs API error: ${response.status}`, {
        ...ErrorCodes.SERVICE_UNAVAILABLE,
      });
    }

    const data: any = await response.json();

    return {
      characterCount: data.character_count,
      characterLimit: data.character_limit,
      tier: data.tier,
    };
  }
}

// Singleton instance
let elevenLabsService: ElevenLabsService | null = null;

export function getElevenLabsService(): ElevenLabsService {
  if (!elevenLabsService) {
    elevenLabsService = new ElevenLabsService();
  }
  return elevenLabsService;
}

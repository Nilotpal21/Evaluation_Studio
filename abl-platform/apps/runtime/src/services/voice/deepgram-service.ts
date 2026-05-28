/**
 * Deepgram Service - Real-time Speech-to-Text
 *
 * Handles streaming audio transcription using Deepgram's WebSocket API.
 */

import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../../config/index.js';
import WebSocket from 'ws';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

const log = createLogger('deepgram-service');

// =============================================================================
// TYPES
// =============================================================================

export interface DeepgramConfig {
  apiKey: string;
  model?: string;
  language?: string;
  punctuate?: boolean;
  smartFormat?: boolean;
  interimResults?: boolean;
  // Audio format options
  encoding?: 'linear16' | 'mulaw' | 'alaw' | 'opus';
  sampleRate?: number;
  channels?: number;
}

export interface TranscriptionResult {
  text: string;
  isFinal: boolean;
  confidence: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
  }>;
}

export interface DeepgramConnection {
  send(audio: Buffer | Uint8Array): void;
  close(): void;
  isOpen(): boolean;
  onTranscript(handler: (result: TranscriptionResult) => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
}

// =============================================================================
// DEEPGRAM SERVICE
// =============================================================================

/** Default Deepgram STT model */
const DEFAULT_DEEPGRAM_MODEL = 'nova-2';

export class DeepgramService {
  private apiKey: string | null = null;
  private defaultConfig: Partial<DeepgramConfig> = {
    model: DEFAULT_DEEPGRAM_MODEL,
    language: 'en',
    punctuate: true,
    smartFormat: true,
    interimResults: true,
  };

  constructor(explicitConfig?: { apiKey: string; model?: string }) {
    if (explicitConfig) {
      this.apiKey = explicitConfig.apiKey;
      if (explicitConfig.model) this.defaultConfig.model = explicitConfig.model;
      log.info('Deepgram configured with explicit credentials');
    } else {
      this.apiKey = getConfig().voice.deepgram.apiKey || null;
      if (this.apiKey) {
        log.info('Deepgram API key configured');
      } else {
        log.warn('Deepgram API key not configured - STT will be disabled');
      }
    }
  }

  /**
   * Create from a decrypted TenantServiceInstance.
   */
  static fromCredentials(apiKey: string, config?: Record<string, unknown>): DeepgramService {
    return new DeepgramService({
      apiKey,
      model: (config?.model as string) || undefined,
    });
  }

  /**
   * Check if Deepgram is configured
   */
  isConfigured(): boolean {
    return this.apiKey !== null;
  }

  /**
   * Create a streaming transcription connection
   */
  async createConnection(config?: Partial<DeepgramConfig>): Promise<DeepgramConnection> {
    if (!this.apiKey) {
      throw new AppError('Deepgram not configured', { ...ErrorCodes.SERVICE_UNAVAILABLE });
    }

    const mergedConfig = { ...this.defaultConfig, ...config };

    // Use provided encoding or default to linear16 for web streaming
    const encoding = mergedConfig.encoding || 'linear16';
    const sampleRate = mergedConfig.sampleRate || (encoding === 'mulaw' ? 8000 : 16000);
    const channels = mergedConfig.channels || 1;

    // Build WebSocket URL with query params
    const params = new URLSearchParams({
      model: mergedConfig.model!,
      language: mergedConfig.language!,
      punctuate: String(mergedConfig.punctuate),
      smart_format: String(mergedConfig.smartFormat),
      interim_results: String(mergedConfig.interimResults),
      encoding,
      sample_rate: String(sampleRate),
      channels: String(channels),
    });

    const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    log.debug('Creating Deepgram connection', { model: mergedConfig.model });

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Token ${this.apiKey}`,
        },
      });

      let transcriptHandler: ((result: TranscriptionResult) => void) | null = null;
      let errorHandler: ((error: Error) => void) | null = null;
      let closeHandler: (() => void) | null = null;

      ws.onopen = () => {
        log.debug('Deepgram connection opened');
        resolve({
          send: (audio: Buffer | Uint8Array) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(audio);
            }
          },
          close: () => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          },
          isOpen: () => ws.readyState === WebSocket.OPEN,
          onTranscript: (handler) => {
            transcriptHandler = handler;
          },
          onError: (handler) => {
            errorHandler = handler;
          },
          onClose: (handler) => {
            closeHandler = handler;
          },
        });
      };

      ws.onmessage = (event: WebSocket.MessageEvent) => {
        try {
          const data = JSON.parse(
            typeof event.data === 'string' ? event.data : event.data.toString(),
          );

          if (data.type === 'Results' && data.channel?.alternatives?.[0]) {
            const alt = data.channel.alternatives[0];
            const result: TranscriptionResult = {
              text: alt.transcript || '',
              isFinal: data.is_final || false,
              confidence: alt.confidence || 0,
              words: alt.words?.map(
                (w: { word: string; start: number; end: number; confidence: number }) => ({
                  word: w.word,
                  start: w.start,
                  end: w.end,
                  confidence: w.confidence,
                }),
              ),
            };

            if (result.text && transcriptHandler) {
              transcriptHandler(result);
            }
          }
        } catch (error) {
          log.error('Failed to parse Deepgram message', { error });
        }
      };

      ws.onerror = (event) => {
        const error = new Error('Deepgram WebSocket error');
        log.error('Deepgram connection error', { error });

        if (errorHandler) {
          errorHandler(error);
        } else {
          reject(error);
        }
      };

      ws.onclose = () => {
        log.debug('Deepgram connection closed');
        if (closeHandler) {
          closeHandler();
        }
      };
    });
  }

  /**
   * Transcribe audio buffer (non-streaming)
   */
  async transcribe(audio: Buffer, mimeType = 'audio/wav'): Promise<TranscriptionResult> {
    if (!this.apiKey) {
      throw new AppError('Deepgram not configured', { ...ErrorCodes.SERVICE_UNAVAILABLE });
    }

    const response = await fetch('https://api.deepgram.com/v1/listen', {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': mimeType,
      },
      body: audio,
    });

    if (!response.ok) {
      throw new AppError(`Deepgram API error: ${response.status}`, {
        ...ErrorCodes.SERVICE_UNAVAILABLE,
      });
    }

    const data: any = await response.json();
    const alt = data.results?.channels?.[0]?.alternatives?.[0];

    return {
      text: alt?.transcript || '',
      isFinal: true,
      confidence: alt?.confidence || 0,
    };
  }
}

// Singleton instance
let deepgramService: DeepgramService | null = null;

export function getDeepgramService(): DeepgramService {
  if (!deepgramService) {
    deepgramService = new DeepgramService();
  }
  return deepgramService;
}

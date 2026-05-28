/**
 * Voice Pipeline - Orchestrates STT → Agent → TTS flow
 *
 * Manages the real-time voice conversation pipeline.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  getDeepgramService,
  type DeepgramConnection,
  type TranscriptionResult,
} from './deepgram-service.js';
import { getElevenLabsService } from './elevenlabs-service.js';
import { getTwilioService } from './twilio-service.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

const log = createLogger('voice-pipeline');

// =============================================================================
// TYPES
// =============================================================================

export interface VoicePipelineConfig {
  sessionId: string;
  projectId: string;
  agentName: string;
  voiceId?: string;
}

export interface VoicePipelineCallbacks {
  onTranscription: (result: TranscriptionResult) => void;
  onAgentResponse: (text: string, isFinal: boolean) => void;
  onAudioChunk: (audio: Uint8Array) => void;
  onError: (error: Error) => void;
  onStateChange: (state: VoicePipelineState) => void;
}

export type VoicePipelineState = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';

// =============================================================================
// VOICE PIPELINE
// =============================================================================

export class VoicePipeline {
  private config: VoicePipelineConfig;
  private callbacks: VoicePipelineCallbacks;
  private deepgramConnection: DeepgramConnection | null = null;
  private state: VoicePipelineState = 'idle';
  private currentUtterance = '';
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly silenceThresholdMs = 1500; // Wait 1.5s after speech ends

  constructor(config: VoicePipelineConfig, callbacks: VoicePipelineCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  /**
   * Start the voice pipeline
   */
  async start(): Promise<void> {
    log.info('Starting voice pipeline', {
      sessionId: this.config.sessionId,
      agentName: this.config.agentName,
    });

    const deepgram = getDeepgramService();

    if (!deepgram.isConfigured()) {
      throw new AppError('Deepgram not configured', { ...ErrorCodes.SERVICE_UNAVAILABLE });
    }

    // Create STT connection
    this.deepgramConnection = await deepgram.createConnection();

    this.deepgramConnection.onTranscript((result) => {
      this.handleTranscription(result);
    });

    this.deepgramConnection.onError((error) => {
      log.error('Deepgram error', { error });
      this.callbacks.onError(error);
      this.setState('error');
    });

    this.deepgramConnection.onClose(() => {
      log.debug('Deepgram connection closed');
    });

    this.setState('listening');
  }

  /**
   * Stop the voice pipeline
   */
  stop(): void {
    log.info('Stopping voice pipeline', { sessionId: this.config.sessionId });

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    if (this.deepgramConnection) {
      this.deepgramConnection.close();
      this.deepgramConnection = null;
    }

    this.setState('idle');
  }

  /**
   * Process incoming audio from Twilio
   */
  processAudio(audio: Buffer | Uint8Array): void {
    if (this.deepgramConnection && this.state === 'listening') {
      this.deepgramConnection.send(audio);
    }
  }

  /**
   * Get current pipeline state
   */
  getState(): VoicePipelineState {
    return this.state;
  }

  /**
   * Check if all services are configured
   */
  static isConfigured(): boolean {
    return (
      getDeepgramService().isConfigured() &&
      getElevenLabsService().isConfigured() &&
      getTwilioService().isConfigured()
    );
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  private handleTranscription(result: TranscriptionResult): void {
    // Forward transcription to callback
    this.callbacks.onTranscription(result);

    if (result.isFinal && result.text.trim()) {
      // Accumulate final transcript
      this.currentUtterance += ' ' + result.text.trim();

      // Reset silence timer
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
      }

      // Wait for silence before processing
      this.silenceTimer = setTimeout(() => {
        this.processUtterance();
      }, this.silenceThresholdMs);
    }
  }

  private async processUtterance(): Promise<void> {
    const utterance = this.currentUtterance.trim();
    this.currentUtterance = '';

    if (!utterance) {
      return;
    }

    log.debug('Processing utterance', { utterance, sessionId: this.config.sessionId });

    this.setState('processing');

    try {
      // In a real implementation, this would call the agent runtime
      // For now, we'll generate a simple response
      const response = await this.getAgentResponse(utterance);

      this.callbacks.onAgentResponse(response, false);

      // Synthesize response to audio
      await this.synthesizeAndStream(response);

      this.callbacks.onAgentResponse(response, true);
    } catch (error) {
      log.error('Utterance processing error', { error });
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }

    this.setState('listening');
  }

  private async getAgentResponse(userInput: string): Promise<string> {
    // This is a placeholder - in production, this would:
    // 1. Send the input to the VoiceRuntime
    // 2. Get the agent's response
    // 3. Return the response text

    // For now, return a simple acknowledgment
    return `I heard you say: "${userInput}". How can I help you further?`;
  }

  private async synthesizeAndStream(text: string): Promise<void> {
    const elevenlabs = getElevenLabsService();

    if (!elevenlabs.isConfigured()) {
      log.warn('ElevenLabs not configured, skipping TTS');
      return;
    }

    this.setState('speaking');

    try {
      for await (const chunk of elevenlabs.synthesizeStream(text, {
        voiceId: this.config.voiceId,
        outputFormat: 'ulaw_8000', // Twilio format
      })) {
        this.callbacks.onAudioChunk(chunk);
      }
    } catch (error) {
      log.error('TTS synthesis error', { error });
      throw error;
    }
  }

  private setState(newState: VoicePipelineState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.callbacks.onStateChange(newState);
    }
  }
}

export function createVoicePipeline(
  config: VoicePipelineConfig,
  callbacks: VoicePipelineCallbacks,
): VoicePipeline {
  return new VoicePipeline(config, callbacks);
}

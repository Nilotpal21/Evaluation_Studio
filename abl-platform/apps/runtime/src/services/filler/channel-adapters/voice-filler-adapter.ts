/**
 * Voice Channel Filler Adapter
 *
 * Bridges the filler service's StatusEvent output to voice channels.
 * In realtime mode: synthesizes short TTS filler audio via session.sendAudio().
 * In pipeline mode: emits a Jambonz `say` verb with the filler text.
 */

import { createLogger } from '@abl/compiler/platform';
import type { StatusEvent, StatusOperation } from '../types.js';
import { getFillerMessage } from '../message-pools.js';

const log = createLogger('voice-filler-adapter');

export interface VoiceFillerSession {
  sendAudio: (audio: Buffer) => void;
  cancelResponse: () => void;
  isBargeInActive: boolean;
  isResponseImminent: boolean;
}

export interface JambonzVerb {
  verb: 'say';
  text: string;
}

export interface VoiceFillerAdapterConfig {
  mode: 'realtime' | 'pipeline';
  session: VoiceFillerSession;
  onJambonzVerb?: (verb: JambonzVerb) => void;
  locale?: string;
  language?: string;
}

export class VoiceChannelFillerAdapter {
  private readonly config: VoiceFillerAdapterConfig;
  private destroyed = false;
  private recentMessages: string[] = [];

  constructor(config: VoiceFillerAdapterConfig) {
    this.config = config;
  }

  /**
   * Handle a StatusEvent from the filler service.
   * Routes to the appropriate output based on voice mode.
   */
  handleStatusEvent(event: StatusEvent): void {
    if (this.destroyed) return;

    const { session } = this.config;

    // Suppress filler during barge-in or when response is imminent
    if (session.isBargeInActive || session.isResponseImminent) {
      log.debug('Filler suppressed', {
        reason: session.isBargeInActive ? 'barge_in' : 'response_imminent',
        text: event.text,
      });
      return;
    }

    const text = event.text;

    if (this.config.mode === 'realtime') {
      this.emitRealtimeFiller(text);
    } else {
      this.emitPipelineFiller(text);
    }

    // Track recent messages to avoid repetition
    this.recentMessages.push(text);
    if (this.recentMessages.length > 5) {
      this.recentMessages.shift();
    }
  }

  /**
   * Get a filler text for the given operation, using the message pools.
   */
  getFillerText(operation: StatusOperation): string {
    return getFillerMessage(operation, this.recentMessages, undefined, {
      language: this.config.language,
      locale: this.config.locale,
      isVoiceChannel: true,
    });
  }

  /**
   * Destroy the adapter, preventing further emissions.
   */
  destroy(): void {
    this.destroyed = true;
  }

  /**
   * Realtime mode: encode filler text as a simple TTS audio payload
   * and send via session.sendAudio().
   */
  private emitRealtimeFiller(text: string): void {
    log.debug('Emitting realtime filler', { text });

    // Encode filler text as UTF-8 buffer — the runtime TTS layer
    // will synthesize this into actual audio before sending to the client.
    const audioPayload = Buffer.from(text, 'utf-8');
    this.config.session.sendAudio(audioPayload);
  }

  /**
   * Pipeline mode: emit a Jambonz `say` verb with the filler text.
   */
  private emitPipelineFiller(text: string): void {
    log.debug('Emitting pipeline filler verb', { text });

    if (this.config.onJambonzVerb) {
      this.config.onJambonzVerb({
        verb: 'say',
        text,
      });
    }
  }
}

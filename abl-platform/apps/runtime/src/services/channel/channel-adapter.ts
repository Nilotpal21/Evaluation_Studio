/**
 * Channel Adapter Registry
 *
 * Resolves message payloads into channel-appropriate output.
 * Text channels get the raw respond string; voice channels get
 * voice-optimized text (plain_text, SSML, or auto-stripped markdown).
 *
 * Phase 2 will add RichConfigIR for Adaptive Cards, AG-UI, etc.
 */

import type { VoiceConfigIR } from '@abl/compiler';
import { RUNTIME_CHANNEL, VOICE_ENGINE } from './constants.js';

// =============================================================================
// INTERFACES
// =============================================================================

/** Context provided to channel adapters for resolution */
export interface ChannelContext {
  channelType: string; // 'web', 'voice', 'mobile_ios', etc.
  engine?: string; // 'elevenlabs', 'openai_realtime', 'gemini_live', etc.
  metadata?: Record<string, unknown>;
}

/** All channel-specific content passed to adapters (extensible bag for Phase 2) */
export interface MessagePayload {
  text: string; // Always present — the interpolated respond string
  voiceConfig?: VoiceConfigIR; // Phase 1: voice overrides
  // richConfig?: RichConfigIR;          // Phase 2: reserved, not used yet
  metadata?: Record<string, unknown>; // Extensible for custom data
}

/** Adapter interface — implement for custom channels */
export interface ChannelAdapter {
  readonly name: string;
  /** Resolve message payload into channel-appropriate output */
  resolve(payload: MessagePayload, context?: ChannelContext): string;
}

// =============================================================================
// BUILT-IN ADAPTERS
// =============================================================================

/** Default text adapter — passthrough (web, mobile, API channels) */
export class TextChannelAdapter implements ChannelAdapter {
  readonly name = 'text';
  resolve(payload: MessagePayload): string {
    return payload.text ?? '';
  }
}

/** Generic plain-text voice adapter — strips markdown/emoji, uses plain_text override */
export class PlainTextVoiceAdapter implements ChannelAdapter {
  readonly name: string = 'voice_plain';
  resolve(payload: MessagePayload): string {
    return payload.voiceConfig?.plain_text || stripForVoice(payload.text ?? '');
  }
}

/** ElevenLabs voice adapter — same plain-text semantics under an engine-specific key */
export class ElevenLabsAdapter extends PlainTextVoiceAdapter {
  readonly name: string = 'elevenlabs';
}

/** Provider-native realtime voice — plain_text override first, otherwise raw text */
export class RealtimeVoiceAdapter implements ChannelAdapter {
  readonly name: string = 'realtime';
  resolve(payload: MessagePayload): string {
    return payload.voiceConfig?.plain_text || (payload.text ?? '');
  }
}

/** SSML adapter — for Google TTS, Azure Speech, Amazon Polly */
export class SSMLVoiceAdapter implements ChannelAdapter {
  readonly name: string = 'ssml';
  resolve(payload: MessagePayload): string {
    return payload.voiceConfig?.ssml || (payload.text ?? '');
  }
}

// =============================================================================
// REGISTRY
// =============================================================================

export class ChannelAdapterRegistry {
  private adapters = new Map<string, ChannelAdapter>();
  private defaultAdapter = new TextChannelAdapter();

  register(key: string, adapter: ChannelAdapter): void {
    this.adapters.set(key, adapter);
  }

  get(key: string): ChannelAdapter {
    return this.adapters.get(key) || this.defaultAdapter;
  }

  /**
   * Resolve a message payload into channel-appropriate text.
   * Priority: engine (most specific) → channelType → default (text passthrough).
   */
  resolve(payload: MessagePayload, context?: ChannelContext): string {
    const adapter =
      (context?.engine ? this.adapters.get(context.engine) : undefined) ??
      (context?.channelType ? this.adapters.get(context.channelType) : undefined) ??
      this.defaultAdapter;
    return adapter.resolve(payload, context);
  }
}

// Singleton with built-in adapters pre-registered
const registry = new ChannelAdapterRegistry();
const plainTextVoiceAdapter = new PlainTextVoiceAdapter();
const plainTextVoiceChannelKeys = [
  RUNTIME_CHANNEL.VOICE,
  'voice_pipeline',
  'voice_realtime',
  'voice_twilio',
  'voice_livekit',
  'voice_vxml',
  'audiocodes',
  'korevg',
] as const;

registry.register('text', new TextChannelAdapter());
registry.register('web', new TextChannelAdapter());
registry.register('voice_plain', plainTextVoiceAdapter);
for (const channelKey of plainTextVoiceChannelKeys) {
  registry.register(channelKey, plainTextVoiceAdapter);
}
registry.register(VOICE_ENGINE.ELEVENLABS, new ElevenLabsAdapter());
registry.register(VOICE_ENGINE.OPENAI_REALTIME, new RealtimeVoiceAdapter());
registry.register(VOICE_ENGINE.GEMINI_LIVE, new RealtimeVoiceAdapter());
registry.register(VOICE_ENGINE.GOOGLE_TTS, new SSMLVoiceAdapter());
registry.register(VOICE_ENGINE.AZURE_SPEECH, new SSMLVoiceAdapter());

export function getChannelAdapterRegistry(): ChannelAdapterRegistry {
  return registry;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Strip markdown/emoji from text for voice readability without trimming chunk boundaries. */
function stripVoiceMarkup(text: string): string {
  if (!text) return '';
  return (
    text
      // Remove emoji (common Unicode ranges)
      .replace(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
        '',
      )
      // Bold **text** → text
      .replace(/\*\*(.+?)\*\*/g, '$1')
      // Italic *text* → text
      .replace(/\*(.+?)\*/g, '$1')
      // Italic _text_ → text
      .replace(/_(.+?)_/g, '$1')
      // Links [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Headers # → remove
      .replace(/^#{1,6}\s+/gm, '')
      // List markers - or * → remove
      .replace(/^\s*[-*]\s+/gm, '')
      // Numbered list markers 1. 2. etc. → remove
      .replace(/^\s*\d+\.\s+/gm, '')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
  );
}

/** Strip markdown/emoji and trim completed text for voice readability. */
export function stripForVoice(text: string): string {
  return stripVoiceMarkup(text).trim();
}

/** Strip markdown/emoji from a streaming voice chunk without removing boundary spaces. */
export function stripForVoiceStreamChunk(text: string): string {
  return stripVoiceMarkup(text);
}

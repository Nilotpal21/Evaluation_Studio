/**
 * Korevg Voice Gateway Channel Adapter
 *
 * Minimal adapter for Korevg WebSocket-based voice gateway.
 * Unlike async channels, Korevg uses a persistent WebSocket connection per call
 * with the Korevg WebSocket subprotocol. The real work happens in the Korevg integration
 * (services/voice/korevg/korevg-router.ts and korevg-session.ts); this adapter exists
 * so the channel registry recognises 'korevg' as a valid channel type.
 *
 * WebSocket path: /api/korevg/ws/:projectId/:deploymentId
 */

import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelType,
  InboundJobPayload,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../types.js';

// ---------------------------------------------------------------------------
// Korevg config stored in ChannelConnection.config JSON
// ---------------------------------------------------------------------------

export interface KorevgChannelConfig {
  recognizerVendor?: string; // ASR vendor (google, aws, deepgram)
  recognizerLanguage?: string; // ASR language (en-US)
  synthesizerVendor?: string; // TTS vendor
  synthesizerLanguage?: string; // TTS language
  synthesizerVoice?: string; // TTS voice name
  bargeIn?: boolean; // Allow caller to interrupt TTS (default: true)
  speechTimeout?: number; // Seconds of silence before end of speech (default: 3)
  welcomeMessage?: string; // Greeting for new calls
  inboundAuthToken?: string; // Optional per-channel shared token for WS ingress
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class KorevgAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'korevg';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: false,
    supportsStreaming: true, // Enable streaming for LLM responses
    supportsMedia: false,
    supportsThreading: false,
  };

  async verifyRequest(_headers: Record<string, string>, _body: unknown): Promise<boolean> {
    return true;
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  async sendResponse(
    _message: NormalizedOutgoingMessage,
    _connection: ResolvedConnection,
  ): Promise<SendResult> {
    // Korevg responses are sent as ACKs on the WebSocket connection —
    // this method is never called but satisfies the adapter interface.
    return { success: true };
  }
}

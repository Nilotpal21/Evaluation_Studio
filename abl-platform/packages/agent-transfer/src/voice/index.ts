/**
 * Voice transfer support (SIP REFER, LiveKit bridge).
 */

import type { VoiceMessagePayload } from '../types.js';

// Voice gateway abstraction
export {
  type VoiceGatewaySession,
  type VoiceGateway,
  type DialAgentOptions,
  type PlayMessageOptions,
  type GatherDTMFOptions,
  VoiceGatewayRegistry,
  getVoiceGatewayRegistry,
} from './voice-gateway.js';

/** Channel detector for voice sessions. */
export const VOICE_CHANNELS = new Set([
  'voice',
  'korevg',
  'audiocodes',
  'twilio',
  'voice_twilio',
  'ivr',
  'jambonz',
]);

export function isVoiceChannel(channel: string): boolean {
  return VOICE_CHANNELS.has(channel);
}

/** Voice event types emitted by OOB flag processing. */
export const VOICE_EVENT_TYPES = {
  DTMF: 'voice:dtmf',
  TRANSFER_STATUS: 'transfer:status',
  OOB_AGENT_TRANSFER: 'oob:agent_transfer',
  OOB_DEFLECTION: 'oob:deflection',
  OOB_OFFER_CHAT: 'oob:offer_chat',
  OOB_CONVERSATION_END: 'oob:conversation_end',
} as const;

/**
 * Build a VoiceMessagePayload from partial input.
 * Fills in defaults for optional fields.
 */
export function buildVoicePayload(
  input: Partial<VoiceMessagePayload> & { message: string; isHangUp: boolean },
): VoiceMessagePayload {
  return {
    message: input.message,
    isPrompt: input.isPrompt ?? false,
    sendDTMF: input.sendDTMF ?? false,
    dtmfCollect: input.dtmfCollect ?? false,
    timeout: input.timeout,
    retries: input.retries,
    bargeIn: input.bargeIn,
    enableSpeechInput: input.enableSpeechInput,
    isHangUp: input.isHangUp,
    isCallTransfer: input.isCallTransfer,
    callTransferConfig: input.callTransferConfig,
    language: input.language,
    dtmfCollectSubmitDigit: input.dtmfCollectSubmitDigit,
    dtmfCollectInterDigitTimeoutMS: input.dtmfCollectInterDigitTimeoutMS,
    dtmfCollectMaxDigits: input.dtmfCollectMaxDigits,
    messages: input.messages,
  };
}

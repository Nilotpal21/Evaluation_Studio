/**
 * Voice Channel Detection Tests (prompt-builder.ts)
 *
 * Validates that isVoiceChannel correctly identifies voice channels
 * using the ChannelManifest's isVoice flag instead of string prefix matching.
 */

import { describe, it, expect } from 'vitest';
import { isVoiceChannel } from '../../services/execution/prompt-builder.js';

const makeSession = (channelType?: string, dataChannel?: string) =>
  ({
    channelType,
    data: {
      values: dataChannel ? { session: { channel: dataChannel } } : {},
    },
  }) as any;

describe('isVoiceChannel with manifest', () => {
  it('should detect voice channel types from manifest', () => {
    expect(isVoiceChannel(makeSession('voice'))).toBe(true);
    expect(isVoiceChannel(makeSession('voice_twilio'))).toBe(true);
    expect(isVoiceChannel(makeSession('voice_livekit'))).toBe(true);
    expect(isVoiceChannel(makeSession('voice_vxml'))).toBe(true);
    expect(isVoiceChannel(makeSession('korevg'))).toBe(true);
  });

  it('should not detect non-voice channels as voice', () => {
    expect(isVoiceChannel(makeSession('slack'))).toBe(false);
    expect(isVoiceChannel(makeSession('msteams'))).toBe(false);
    expect(isVoiceChannel(makeSession('http_async'))).toBe(false);
    expect(isVoiceChannel(makeSession('ag_ui'))).toBe(false);
    expect(isVoiceChannel(makeSession('email'))).toBe(false);
    expect(isVoiceChannel(makeSession('sdk_websocket'))).toBe(false);
  });

  it('should handle missing/undefined channelType gracefully', () => {
    expect(isVoiceChannel(makeSession(undefined))).toBe(false);
    expect(isVoiceChannel({ data: { values: {} } } as any)).toBe(false);
  });

  it('should use session.data.values.session.channel as fallback', () => {
    expect(isVoiceChannel(makeSession(undefined, 'korevg'))).toBe(true);
    expect(isVoiceChannel(makeSession(undefined, 'voice'))).toBe(true);
    expect(isVoiceChannel(makeSession(undefined, 'slack'))).toBe(false);
  });

  it('should fall back to prefix check for unknown channel types', () => {
    // Unknown voice-prefixed type not in manifest → prefix fallback
    expect(isVoiceChannel(makeSession('voice_custom_new'))).toBe(true);
    // Unknown non-voice type → false
    expect(isVoiceChannel(makeSession('custom_channel'))).toBe(false);
  });

  it('should prefer channelType over data.values.session.channel', () => {
    // channelType is slack (non-voice), data says voice → should be non-voice
    expect(isVoiceChannel(makeSession('slack', 'voice'))).toBe(false);
    // channelType is voice, data says slack → should be voice
    expect(isVoiceChannel(makeSession('voice', 'slack'))).toBe(true);
  });
});

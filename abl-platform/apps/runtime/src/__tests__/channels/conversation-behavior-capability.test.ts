import { describe, expect, it } from 'vitest';
import { resolveConversationBehavior } from '../../services/execution/conversation-behavior-resolver.js';

describe('conversation behavior capability gating', () => {
  it('preserves listening behavior on voice-capable channels', () => {
    const resolved = resolveConversationBehavior({
      channelType: 'voice_vxml',
      baseBehavior: {
        listening: {
          barge_in: 'allow',
          on_overlap: 'stop_and_listen',
        },
      },
      activeProfiles: [],
    });

    expect(resolved).toMatchObject({
      listening: {
        barge_in: 'allow',
        on_overlap: 'stop_and_listen',
      },
      sourceChain: ['agent'],
      capabilityDrops: [],
    });
  });

  it('drops listening behavior on digital channels field-by-field with stable diagnostics', () => {
    const resolved = resolveConversationBehavior({
      channelType: 'sms',
      baseBehavior: {
        speaking: {
          max_sentences: 1,
        },
        listening: {
          barge_in: 'allow',
          on_overlap: 'stop_and_listen',
          on_unclear_audio: 'ask_to_repeat_or_confirm',
        },
      },
      activeProfiles: [],
    });

    expect(resolved).toMatchObject({
      speaking: {
        max_sentences: 1,
      },
      sourceChain: ['agent'],
    });
    expect(resolved?.capabilityDrops).toEqual([
      {
        fieldPath: 'listening.barge_in',
        reason: 'voice_channel_required',
        message:
          'Listening behavior requires a voice-capable channel, but "sms" is not voice-capable.',
      },
      {
        fieldPath: 'listening.on_overlap',
        reason: 'voice_channel_required',
        message:
          'Listening behavior requires a voice-capable channel, but "sms" is not voice-capable.',
      },
      {
        fieldPath: 'listening.on_unclear_audio',
        reason: 'voice_channel_required',
        message:
          'Listening behavior requires a voice-capable channel, but "sms" is not voice-capable.',
      },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { CHANNEL_MANIFEST, getVoiceChannelTypes } from '../../channels/manifest.js';
import type { ChannelType } from '../../channels/types.js';
import {
  CHANNEL_BEHAVIOR_CONTRACT,
  CHANNEL_BEHAVIOR_PROFILES,
  CHANNEL_LOGICAL_FAMILIES,
  VOICE_BEHAVIOR_PROFILES,
  getChannelBehaviorContract,
  getChannelTypesByBehaviorProfile,
  getChannelTypesByRichContentMode,
  getChannelTypesByLogicalFamily,
  getChannelTypesByTraceDelivery,
  getLogicalFamilyForChannelType,
  getVoiceBehaviorProfileForChannelType,
  getVoiceChannelTypesByBehaviorProfile,
  isChannelBehaviorContractAlignedWithManifest,
  requireChannelBehaviorContract,
} from '../../channels/channel-behavior-contract.js';

describe('channel behavior contract', () => {
  it('defines exactly one contract row for every manifest channel', () => {
    expect(Object.keys(CHANNEL_BEHAVIOR_CONTRACT).sort()).toEqual(
      Object.keys(CHANNEL_MANIFEST).sort(),
    );
    expect(isChannelBehaviorContractAlignedWithManifest()).toBe(true);
  });

  it('returns undefined for unknown channel types', () => {
    expect(getChannelBehaviorContract('unknown_channel')).toBeUndefined();
  });

  it('requires known channel contracts', () => {
    expect(requireChannelBehaviorContract('web_debug')).toEqual(
      CHANNEL_BEHAVIOR_CONTRACT.web_debug,
    );
  });

  it('captures the current Studio debug contract explicitly', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.web_debug).toEqual({
      traceDelivery: 'stream',
      bannerPolicy: 'studio_debug_config_only',
      preflightAuth: 'interactive_gate',
      jitAuth: 'interactive',
      richContent: 'full',
      voiceConfig: 'full',
      attachmentSupport: 'upload_and_send',
      formSubmission: 'interactive_submit',
      proactiveDelivery: 'on_start_and_async_updates',
      presenceSemantics: 'typing_and_thoughts',
      sessionClosure: 'explicit_end_event',
      sessionOutcomeEvidence: 'explicit_end_event',
      timeoutHandling: 'direct_handler',
      sessionLifecycle: 'create_resume_join',
      identityLinking: 'none',
      implementationStatus: 'partial',
    });
  });

  it('captures the current SDK websocket contract explicitly', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.sdk_websocket).toEqual({
      traceDelivery: 'stream',
      bannerPolicy: 'none',
      preflightAuth: 'interactive_gate',
      jitAuth: 'interactive',
      richContent: 'full',
      voiceConfig: 'ignored',
      attachmentSupport: 'upload_and_send',
      formSubmission: 'interactive_submit',
      proactiveDelivery: 'on_start_and_async_updates',
      presenceSemantics: 'typing_and_thoughts',
      sessionClosure: 'explicit_end_event',
      sessionOutcomeEvidence: 'explicit_end_event',
      timeoutHandling: 'ws_error_close',
      sessionLifecycle: 'create_resume',
      identityLinking: 'verified_contact',
      implementationStatus: 'partial',
    });
  });

  it('keeps the SDK conversational websocket surfaces aligned as one logical family', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.web_chat).toEqual(CHANNEL_BEHAVIOR_CONTRACT.sdk_websocket);
  });

  it('captures the current HTTP sync contract explicitly', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.http).toEqual({
      traceDelivery: 'inline',
      bannerPolicy: 'none',
      preflightAuth: 'outcome_only',
      jitAuth: 'unsupported',
      richContent: 'full',
      voiceConfig: 'full',
      attachmentSupport: 'upload_and_send',
      formSubmission: 'none',
      proactiveDelivery: 'none',
      presenceSemantics: 'none',
      sessionClosure: 'implicit_only',
      sessionOutcomeEvidence: 'implicit_or_ttl',
      timeoutHandling: 'shared_outcome',
      sessionLifecycle: 'create_resume',
      identityLinking: 'verified_contact',
      implementationStatus: 'working',
    });
  });

  it('captures the current HTTP async contract explicitly', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.http_async).toEqual({
      traceDelivery: 'correlation_only',
      bannerPolicy: 'none',
      preflightAuth: 'outcome_only',
      jitAuth: 'unsupported',
      richContent: 'structured_passthrough',
      voiceConfig: 'ignored',
      attachmentSupport: 'none',
      formSubmission: 'none',
      proactiveDelivery: 'channel_native',
      presenceSemantics: 'none',
      sessionClosure: 'implicit_only',
      sessionOutcomeEvidence: 'implicit_or_ttl',
      timeoutHandling: 'shared_outcome',
      sessionLifecycle: 'implicit_resume',
      identityLinking: 'artifact_only',
      implementationStatus: 'working',
    });
  });

  it('captures the current LiveKit voice contract explicitly', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_livekit).toEqual({
      traceDelivery: 'correlation_only',
      bannerPolicy: 'none',
      preflightAuth: 'outcome_only',
      jitAuth: 'unsupported',
      richContent: 'text_only',
      voiceConfig: 'plain_text_only',
      attachmentSupport: 'none',
      formSubmission: 'none',
      proactiveDelivery: 'on_start',
      presenceSemantics: 'none',
      sessionClosure: 'explicit_end_event',
      sessionOutcomeEvidence: 'transport_lifecycle_event',
      timeoutHandling: 'shared_outcome',
      sessionLifecycle: 'ephemeral',
      identityLinking: 'verified_contact',
      implementationStatus: 'partial',
    });
  });

  it('captures direct-handler outliers explicitly', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.korevg).toEqual({
      traceDelivery: 'observability_only',
      bannerPolicy: 'none',
      preflightAuth: 'outcome_only',
      jitAuth: 'unsupported',
      richContent: 'text_only',
      voiceConfig: 'plain_text_only',
      attachmentSupport: 'none',
      formSubmission: 'none',
      proactiveDelivery: 'on_start',
      presenceSemantics: 'none',
      sessionClosure: 'implicit_only',
      sessionOutcomeEvidence: 'provider_disconnect_attribution',
      timeoutHandling: 'shared_outcome',
      sessionLifecycle: 'ephemeral',
      identityLinking: 'verified_contact',
      implementationStatus: 'partial',
    });

    expect(CHANNEL_BEHAVIOR_CONTRACT.audiocodes).toEqual({
      traceDelivery: 'observability_only',
      bannerPolicy: 'none',
      preflightAuth: 'outcome_only',
      jitAuth: 'unsupported',
      richContent: 'text_only',
      voiceConfig: 'plain_text_only',
      attachmentSupport: 'none',
      formSubmission: 'none',
      proactiveDelivery: 'on_start',
      presenceSemantics: 'none',
      sessionClosure: 'implicit_only',
      sessionOutcomeEvidence: 'transport_lifecycle_event',
      timeoutHandling: 'shared_outcome',
      sessionLifecycle: 'implicit_resume',
      identityLinking: 'verified_contact',
      implementationStatus: 'partial',
    });

    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_twilio).toEqual({
      traceDelivery: 'observability_only',
      bannerPolicy: 'none',
      preflightAuth: 'outcome_only',
      jitAuth: 'unsupported',
      richContent: 'text_only',
      voiceConfig: 'plain_text_only',
      attachmentSupport: 'none',
      formSubmission: 'none',
      proactiveDelivery: 'on_start',
      presenceSemantics: 'none',
      sessionClosure: 'implicit_only',
      sessionOutcomeEvidence: 'provider_terminal_status',
      timeoutHandling: 'shared_outcome',
      sessionLifecycle: 'implicit_resume',
      identityLinking: 'verified_contact',
      implementationStatus: 'partial',
    });
  });

  it('captures AI4W as a markdown-flattened text-only channel boundary', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.ai4w).toMatchObject({
      traceDelivery: 'correlation_only',
      richContent: 'text_only',
      voiceConfig: 'ignored',
      formSubmission: 'none',
    });
    expect(CHANNEL_MANIFEST.ai4w).toMatchObject({
      responseFormat: 'markdown',
      supportsRichOutput: false,
      supportsStreaming: true,
    });
  });

  it('captures telephony bridges with session-resolver-backed contact linking explicitly', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_vxml.voiceConfig).toBe('plain_text_only');
    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_vxml.identityLinking).toBe('verified_contact');
    expect(CHANNEL_BEHAVIOR_CONTRACT.audiocodes.voiceConfig).toBe('plain_text_only');
    expect(CHANNEL_BEHAVIOR_CONTRACT.audiocodes.identityLinking).toBe('verified_contact');
    expect(CHANNEL_BEHAVIOR_CONTRACT.korevg.voiceConfig).toBe('plain_text_only');
    expect(CHANNEL_BEHAVIOR_CONTRACT.korevg.identityLinking).toBe('verified_contact');
    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_livekit.identityLinking).toBe('verified_contact');
    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_twilio.identityLinking).toBe('verified_contact');
  });

  it('captures the voice-family closure and outcome evidence spectrum explicitly', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_twilio).toMatchObject({
      sessionClosure: 'implicit_only',
      sessionOutcomeEvidence: 'provider_terminal_status',
      identityLinking: 'verified_contact',
    });

    expect(CHANNEL_BEHAVIOR_CONTRACT.korevg).toMatchObject({
      sessionClosure: 'implicit_only',
      sessionOutcomeEvidence: 'provider_disconnect_attribution',
      identityLinking: 'verified_contact',
    });

    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_vxml).toMatchObject({
      sessionClosure: 'implicit_only',
      sessionOutcomeEvidence: 'transport_lifecycle_event',
      identityLinking: 'verified_contact',
    });

    expect(CHANNEL_BEHAVIOR_CONTRACT.audiocodes).toMatchObject({
      sessionClosure: 'implicit_only',
      sessionOutcomeEvidence: 'transport_lifecycle_event',
      identityLinking: 'verified_contact',
    });

    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_livekit).toMatchObject({
      sessionClosure: 'explicit_end_event',
      sessionOutcomeEvidence: 'transport_lifecycle_event',
      identityLinking: 'verified_contact',
    });
  });

  it('captures the current messaging adapter parity split explicitly', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.slack).toMatchObject({
      richContent: 'full',
      formSubmission: 'interactive_submit',
      presenceSemantics: 'channel_native_typing',
      attachmentSupport: 'channel_media_ingest',
    });

    expect(CHANNEL_BEHAVIOR_CONTRACT.msteams).toMatchObject({
      richContent: 'full',
      formSubmission: 'interactive_submit',
      presenceSemantics: 'channel_native_typing',
      attachmentSupport: 'channel_media_ingest',
    });

    expect(CHANNEL_BEHAVIOR_CONTRACT.telegram).toMatchObject({
      richContent: 'actions_only',
      formSubmission: 'interactive_submit',
      presenceSemantics: 'channel_native_typing',
      attachmentSupport: 'channel_media_ingest',
    });

    expect(CHANNEL_BEHAVIOR_CONTRACT.whatsapp).toMatchObject({
      richContent: 'full',
      formSubmission: 'interactive_submit',
      presenceSemantics: 'none',
      attachmentSupport: 'channel_media_ingest',
    });

    expect(CHANNEL_BEHAVIOR_CONTRACT.twilio_sms).toMatchObject({
      richContent: 'text_only',
      formSubmission: 'none',
      presenceSemantics: 'none',
      attachmentSupport: 'none',
    });

    expect(CHANNEL_BEHAVIOR_CONTRACT.email).toMatchObject({
      richContent: 'text_only',
      formSubmission: 'none',
      presenceSemantics: 'none',
      attachmentSupport: 'none',
    });
  });

  it('keeps rich-content capability families explicit for every manifest channel', () => {
    expect(getChannelTypesByRichContentMode('full').sort()).toEqual(
      [
        'api',
        'http',
        'instagram',
        'messenger',
        'msteams',
        'sdk_websocket',
        'slack',
        'web_chat',
        'web_debug',
        'whatsapp',
      ].sort(),
    );
    expect(getChannelTypesByRichContentMode('actions_only').sort()).toEqual(
      ['genesys', 'line', 'telegram', 'zendesk'].sort(),
    );
    expect(getChannelTypesByRichContentMode('text_only').sort()).toEqual(
      [
        'ai4w',
        'audiocodes',
        'email',
        'korevg',
        'twilio_sms',
        'voice',
        'voice_livekit',
        'voice_pipeline',
        'voice_realtime',
        'voice_twilio',
        'voice_vxml',
      ].sort(),
    );
    expect(getChannelTypesByRichContentMode('structured_passthrough').sort()).toEqual(
      ['a2a', 'ag_ui', 'http_async'].sort(),
    );
  });

  it('captures the current A2A contract explicitly', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.a2a).toEqual({
      traceDelivery: 'observability_only',
      bannerPolicy: 'none',
      preflightAuth: 'unsupported',
      jitAuth: 'unsupported',
      richContent: 'structured_passthrough',
      voiceConfig: 'ignored',
      attachmentSupport: 'artifact_parts',
      formSubmission: 'none',
      proactiveDelivery: 'async_updates',
      presenceSemantics: 'status_updates',
      sessionClosure: 'implicit_only',
      sessionOutcomeEvidence: 'task_terminal',
      timeoutHandling: 'shared_outcome',
      sessionLifecycle: 'implicit_resume',
      identityLinking: 'none',
      implementationStatus: 'partial',
    });
  });

  it('keeps AG-UI explicitly scoped as a separate stack', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.ag_ui).toEqual({
      traceDelivery: 'observability_only',
      bannerPolicy: 'none',
      preflightAuth: 'unsupported',
      jitAuth: 'unsupported',
      richContent: 'structured_passthrough',
      voiceConfig: 'ignored',
      attachmentSupport: 'artifact_parts',
      formSubmission: 'none',
      proactiveDelivery: 'channel_native',
      presenceSemantics: 'status_updates',
      sessionClosure: 'implicit_only',
      sessionOutcomeEvidence: 'implicit_or_ttl',
      timeoutHandling: 'direct_handler',
      sessionLifecycle: 'implicit_resume',
      identityLinking: 'artifact_only',
      implementationStatus: 'separate_stack',
    });
  });

  it('can derive channels by trace delivery mode', () => {
    const streamed = new Set(getChannelTypesByTraceDelivery('stream'));
    const inline = new Set(getChannelTypesByTraceDelivery('inline'));

    expect(streamed.has('web_debug')).toBe(true);
    expect(streamed.has('sdk_websocket')).toBe(true);
    expect(streamed.has('http')).toBe(false);

    expect(inline.has('http')).toBe(true);
    expect(inline.has('api')).toBe(true);
    expect(inline.has('web_debug')).toBe(false);
  });

  it('assigns every manifest channel to exactly one logical family', () => {
    const allAssigned = Object.values(CHANNEL_LOGICAL_FAMILIES).flat();

    expect([...allAssigned].sort()).toEqual(Object.keys(CHANNEL_MANIFEST).sort());

    const counts = new Map<string, number>();
    for (const channel of allAssigned) {
      counts.set(channel, (counts.get(channel) ?? 0) + 1);
    }

    for (const channel of Object.keys(CHANNEL_MANIFEST)) {
      expect(counts.get(channel)).toBe(1);
    }
  });

  it('keeps the SDK conversational family explicit', () => {
    expect(getChannelTypesByLogicalFamily('sdk_chat')).toEqual(['web_chat', 'sdk_websocket']);
    expect(getLogicalFamilyForChannelType('web_chat')).toBe('sdk_chat');
    expect(getLogicalFamilyForChannelType('sdk_websocket')).toBe('sdk_chat');
    expect(CHANNEL_BEHAVIOR_PROFILES.web_chat).toBe('sdk_chat');
    expect(CHANNEL_BEHAVIOR_PROFILES.sdk_websocket).toBe('sdk_chat');
    expect(CHANNEL_BEHAVIOR_CONTRACT.web_chat.proactiveDelivery).toBe('on_start_and_async_updates');
    expect(CHANNEL_BEHAVIOR_CONTRACT.sdk_websocket.proactiveDelivery).toBe(
      'on_start_and_async_updates',
    );
  });

  it('keeps A2A explicit as its own logical family', () => {
    expect(getChannelTypesByLogicalFamily('a2a')).toEqual(['a2a']);
    expect(getLogicalFamilyForChannelType('a2a')).toBe('a2a');
  });

  it('defines a semantic behavior profile for every manifest channel', () => {
    expect(Object.keys(CHANNEL_BEHAVIOR_PROFILES).sort()).toEqual(
      Object.keys(CHANNEL_MANIFEST).sort(),
    );
  });

  it('makes the generic voice-core inheritance explicit across voice transports', () => {
    expect(getChannelTypesByBehaviorProfile('voice_core').sort()).toEqual(
      ['audiocodes', 'korevg', 'voice_livekit', 'voice_twilio', 'voice_vxml'].sort(),
    );
  });

  it('keeps the voice behavior profiles explicit for parity work', () => {
    expect([...VOICE_BEHAVIOR_PROFILES]).toEqual(['sdk_voice', 'voice_core']);
    expect(getVoiceChannelTypesByBehaviorProfile('sdk_voice').sort()).toEqual(
      ['voice', 'voice_pipeline', 'voice_realtime'].sort(),
    );
    expect(getVoiceChannelTypesByBehaviorProfile('voice_core').sort()).toEqual(
      ['audiocodes', 'korevg', 'voice_livekit', 'voice_twilio', 'voice_vxml'].sort(),
    );
  });

  it('maps every manifest voice channel to an explicit voice behavior profile', () => {
    for (const channelType of getVoiceChannelTypes()) {
      expect(getVoiceBehaviorProfileForChannelType(channelType as ChannelType)).not.toBeNull();
    }
  });

  it('distinguishes voice outcome evidence strength across telephony transports', () => {
    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_twilio.sessionOutcomeEvidence).toBe(
      'provider_terminal_status',
    );
    expect(CHANNEL_BEHAVIOR_CONTRACT.korevg.sessionOutcomeEvidence).toBe(
      'provider_disconnect_attribution',
    );
    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_vxml.sessionOutcomeEvidence).toBe(
      'transport_lifecycle_event',
    );
    expect(CHANNEL_BEHAVIOR_CONTRACT.audiocodes.sessionOutcomeEvidence).toBe(
      'transport_lifecycle_event',
    );
    expect(CHANNEL_BEHAVIOR_CONTRACT.voice_livekit.sessionOutcomeEvidence).toBe(
      'transport_lifecycle_event',
    );
  });
});

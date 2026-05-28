import { describe, expect, it } from 'vitest';
import {
  buildRuntimeTransferEnvelope,
  buildRuntimeTransferContextSnapshot,
  buildRuntimeTransferRoutingContext,
  setRuntimeTransferActiveState,
} from '../transfer-routing-context.js';

describe('buildRuntimeTransferRoutingContext', () => {
  it('normalizes sdk websocket sessions to chat routing and keeps digital return-route hints', () => {
    expect(
      buildRuntimeTransferRoutingContext({
        session: {
          id: 'runtime-1',
          channelType: 'sdk_websocket',
          callerContext: {
            tenantId: 'tenant-1',
            channel: 'sdk_websocket',
            contactId: 'contact-1',
            identityTier: 2,
            verificationMethod: 'sdk_session',
          },
        } as any,
        conversationSessionId: 'conversation-1',
        channelConnectionId: 'conn-1',
        externalSessionKey: 'sdk:customer-1',
      }),
    ).toEqual({
      runtimeSessionId: 'runtime-1',
      conversationSessionId: 'conversation-1',
      resolvedContactId: 'contact-1',
      normalizedTransferChannel: 'chat',
      sourceChannelType: 'sdk_websocket',
      channelConnectionId: 'conn-1',
      externalSessionKey: 'sdk:customer-1',
    });
  });

  it('normalizes voice bridge sessions to voice routing and preserves voice identifiers', () => {
    expect(
      buildRuntimeTransferRoutingContext({
        session: {
          id: 'runtime-voice-1',
          channelType: 'korevg',
          callerContext: {
            tenantId: 'tenant-1',
            channel: 'korevg',
            customerId: 'customer-1',
            identityTier: 1,
            verificationMethod: 'caller_id',
          },
        } as any,
        voice: {
          callSid: 'call-1',
          sipCallId: 'sip-1',
          gateway: 'korevg',
        },
      }),
    ).toEqual({
      runtimeSessionId: 'runtime-voice-1',
      resolvedContactId: 'customer-1',
      normalizedTransferChannel: 'voice',
      sourceChannelType: 'korevg',
      voice: {
        callSid: 'call-1',
        sipCallId: 'sip-1',
        gateway: 'korevg',
      },
    });
  });
});

describe('buildRuntimeTransferContextSnapshot', () => {
  it('captures identity hints and merges them with provided contact and interaction context', () => {
    expect(
      buildRuntimeTransferContextSnapshot({
        callerContext: {
          tenantId: 'tenant-1',
          channel: 'slack',
          customerId: 'customer-1',
          anonymousId: 'anon-1',
          channelArtifactType: 'device_id',
          identityTier: 2,
          verificationMethod: 'provider',
        },
        contact: {
          displayName: 'Taylor Customer',
          email: 'taylor@example.com',
        },
        interactionContext: {
          language: 'en',
          locale: 'en-US',
          timezone: 'America/New_York',
        },
        messageMetadata: {
          correlationId: 'corr-1',
        },
      }),
    ).toEqual({
      identityHints: {
        customerId: 'customer-1',
        anonymousId: 'anon-1',
        identityTier: 2,
        verificationMethod: 'provider',
        channelArtifactType: 'device_id',
      },
      contact: {
        displayName: 'Taylor Customer',
        email: 'taylor@example.com',
      },
      interactionContext: {
        language: 'en',
        locale: 'en-US',
        timezone: 'America/New_York',
      },
      messageMetadata: {
        correlationId: 'corr-1',
      },
    });
  });
});

describe('buildRuntimeTransferEnvelope', () => {
  it('builds a canonical transfer envelope from runtime session identity and interaction context', async () => {
    await expect(
      buildRuntimeTransferEnvelope({
        session: {
          id: 'runtime-1',
          channelType: 'sdk_websocket',
          callerContext: {
            tenantId: 'tenant-1',
            channel: 'sdk_websocket',
            channelId: 'conn-1',
            contactId: 'contact-1',
            customerId: 'customer-1',
            anonymousId: 'anon-1',
            identityTier: 2,
            verificationMethod: 'sdk_session',
            channelArtifactType: 'device_id',
            contactDisplayName: 'Taylor Customer',
            contactContext: {
              firstName: 'Taylor',
              email: 'taylor@example.com',
              phone: '+15551234567',
            },
          },
          data: {
            values: {
              session: {
                conversationSessionId: 'conversation-1',
                externalSessionKey: 'sdk:customer-1',
                interaction: {
                  current: {
                    language: 'en',
                    locale: 'en-US',
                    timezone: 'America/New_York',
                  },
                },
              },
              customer_id: 'customer-1',
            },
            gatheredKeys: new Set(),
          },
        } as any,
      }),
    ).resolves.toEqual({
      contactId: 'contact-1',
      contact: {
        firstName: 'Taylor',
        displayName: 'Taylor Customer',
        email: 'taylor@example.com',
        phone: '+15551234567',
        customerId: 'customer-1',
      },
      routing: {
        runtimeSessionId: 'runtime-1',
        conversationSessionId: 'conversation-1',
        resolvedContactId: 'contact-1',
        normalizedTransferChannel: 'chat',
        sourceChannelType: 'sdk_websocket',
        channelConnectionId: 'conn-1',
        externalSessionKey: 'sdk:customer-1',
      },
      contextSnapshot: {
        identityHints: {
          customerId: 'customer-1',
          anonymousId: 'anon-1',
          identityTier: 2,
          verificationMethod: 'sdk_session',
          channelArtifactType: 'device_id',
        },
        contact: {
          firstName: 'Taylor',
          displayName: 'Taylor Customer',
          email: 'taylor@example.com',
          phone: '+15551234567',
          customerId: 'customer-1',
        },
        interactionContext: {
          language: 'en',
          locale: 'en-US',
          timezone: 'America/New_York',
        },
      },
      language: 'en',
      conversationSessionId: 'conversation-1',
      channelConnectionId: 'conn-1',
      externalSessionKey: 'sdk:customer-1',
    });
  });
});

describe('setRuntimeTransferActiveState', () => {
  it('toggles runtime transfer flags together', () => {
    const session = {
      isEscalated: false,
      transferInitiated: false,
    };

    setRuntimeTransferActiveState(session, true);
    expect(session).toEqual({
      isEscalated: true,
      transferInitiated: true,
    });

    setRuntimeTransferActiveState(session, false);
    expect(session).toEqual({
      isEscalated: false,
      transferInitiated: false,
    });
  });
});

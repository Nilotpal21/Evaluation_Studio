import { describe, expect, it } from 'vitest';

import { buildStoredSessionCallerContext } from '../../services/identity/stored-session-caller-context.js';

describe('buildStoredSessionCallerContext', () => {
  it('prefers persisted sessionPrincipalId over the legacy anonymousId alias', () => {
    const callerContext = buildStoredSessionCallerContext(
      {
        tenantId: 'tenant-stored',
        channel: 'sdk_websocket',
        customerId: 'customer-1',
        sessionPrincipalId: 'session-principal-1',
        anonymousId: 'legacy-anon-1',
        contactId: 'contact-1',
        channelArtifact: 'artifact-hash-1',
        channelId: 'channel-1',
        identityTier: 2,
        verificationMethod: 'hmac',
      },
      'tenant-fallback',
    );

    expect(callerContext).toEqual({
      tenantId: 'tenant-stored',
      channel: 'sdk_websocket',
      customerId: 'customer-1',
      contactId: 'contact-1',
      sessionPrincipalId: 'session-principal-1',
      anonymousId: 'legacy-anon-1',
      channelArtifact: 'artifact-hash-1',
      channelId: 'channel-1',
      identityTier: 2,
      verificationMethod: 'hmac',
      authScope: 'user',
    });
  });

  it('rehydrates a session auth scope from anonymousId when the legacy field is all that exists', () => {
    const callerContext = buildStoredSessionCallerContext(
      {
        channel: 'sdk_websocket',
        anonymousId: 'legacy-anon-2',
      },
      'tenant-fallback',
    );

    expect(callerContext).toEqual({
      tenantId: 'tenant-fallback',
      channel: 'sdk_websocket',
      customerId: undefined,
      contactId: undefined,
      sessionPrincipalId: 'legacy-anon-2',
      anonymousId: 'legacy-anon-2',
      channelArtifact: undefined,
      channelId: undefined,
      identityTier: 0,
      verificationMethod: 'none',
      authScope: 'session',
    });
  });
});

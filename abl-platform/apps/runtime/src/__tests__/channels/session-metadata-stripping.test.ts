import { describe, it, expect } from 'vitest';
import { stripSessionMetadataForPersistence } from '../../channels/session-resolver.js';
import {
  buildChannelSessionMetadataForPersistence,
  mergeReloadedSessionMetadata,
  readDurableSessionMetadataFromChannelSessionMetadata,
} from '../../services/session-metadata.js';

describe('stripSessionMetadataForPersistence', () => {
  it('strips sessionMetadata from metadata object', () => {
    const metadata = {
      sessionMetadata: { token: 'secret-jwt' },
      messageMetadata: { correlationId: 'corr-1' },
      channelData: { source: 'slack' },
    };
    const result = stripSessionMetadataForPersistence(metadata);
    expect(result).toEqual({
      messageMetadata: { correlationId: 'corr-1' },
      channelData: { source: 'slack' },
    });
    expect(result).not.toHaveProperty('sessionMetadata');
  });

  it('returns remaining metadata when no sessionMetadata present', () => {
    const metadata = { messageMetadata: { locale: 'en' } };
    const result = stripSessionMetadataForPersistence(metadata);
    expect(result).toEqual({ messageMetadata: { locale: 'en' } });
  });

  it('returns empty object for undefined metadata', () => {
    const result = stripSessionMetadataForPersistence(undefined);
    expect(result).toEqual({});
  });

  it('returns empty object when metadata only contains sessionMetadata', () => {
    const metadata = { sessionMetadata: { token: 'abc' } };
    const result = stripSessionMetadataForPersistence(metadata);
    expect(result).toEqual({});
  });
});

describe('buildChannelSessionMetadataForPersistence', () => {
  it('persists only the durable sessionMetadata subset alongside channel metadata', () => {
    const metadata = {
      sessionMetadata: {
        token: 'secret-jwt',
        locale: 'fr-FR',
        clientInfo: {
          locale: 'fr-FR',
          timezone: 'Europe/Paris',
          authToken: 'do-not-persist',
        },
        interactionContext: {
          language: 'fr',
          timezone: 'Europe/Paris',
          apiKey: 'do-not-persist',
        },
      },
      messageMetadata: { correlationId: 'corr-1' },
      channelData: { source: 'slack' },
    };

    expect(buildChannelSessionMetadataForPersistence(metadata)).toEqual({
      sessionMetadata: {
        locale: 'fr-FR',
        clientInfo: {
          locale: 'fr-FR',
          timezone: 'Europe/Paris',
        },
        interactionContext: {
          language: 'fr',
          timezone: 'Europe/Paris',
        },
      },
      messageMetadata: { correlationId: 'corr-1' },
      channelData: { source: 'slack' },
    });
  });
});

describe('readDurableSessionMetadataFromChannelSessionMetadata', () => {
  it('returns the durable sessionMetadata subset from a channel-session row', () => {
    expect(
      readDurableSessionMetadataFromChannelSessionMetadata({
        sessionMetadata: {
          locale: 'pt-BR',
          token: 'do-not-reload',
          clientInfo: {
            timezone: 'America/Sao_Paulo',
            secret: 'do-not-reload',
          },
        },
      }),
    ).toEqual({
      locale: 'pt-BR',
      clientInfo: {
        timezone: 'America/Sao_Paulo',
      },
    });
  });
});

describe('mergeReloadedSessionMetadata', () => {
  it('overlays fresh ingress metadata on the durable base while preserving nested continuity fields', () => {
    expect(
      mergeReloadedSessionMetadata(
        {
          locale: 'pt-BR',
          clientInfo: {
            locale: 'pt-BR',
            timezone: 'America/Sao_Paulo',
          },
        },
        {
          token: 'fresh-secret',
          clientInfo: {
            timezone: 'Europe/Paris',
            authToken: 'fresh-client-secret',
          },
        },
      ),
    ).toEqual({
      locale: 'pt-BR',
      token: 'fresh-secret',
      clientInfo: {
        locale: 'pt-BR',
        timezone: 'Europe/Paris',
        authToken: 'fresh-client-secret',
      },
    });
  });
});

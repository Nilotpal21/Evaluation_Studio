import { describe, expect, test } from 'vitest';
import {
  extractLegacyClientInfoInteractionContext,
  getCurrentInteractionParsingLocale,
  inferInteractionContextFromUserMessage,
  normalizeInteractionContextInput,
  resolveAndApplyInteractionContextToSessionData,
  resolveInteractionContext,
} from '../../services/execution/interaction-context.js';

describe('interaction-context resolver', () => {
  test('normalizes valid explicit interaction context values', () => {
    expect(
      normalizeInteractionContextInput(
        {
          language: 'ES-mx',
          locale: 'fr-fr',
          timezone: 'Europe/Paris',
        },
        'strict',
      ),
    ).toEqual({
      success: true,
      data: {
        language: 'es',
        locale: 'fr-FR',
        timezone: 'Europe/Paris',
      },
      issues: [],
    });
  });

  test('rejects invalid explicit interaction context values in strict mode', () => {
    const result = normalizeInteractionContextInput(
      {
        locale: 'not_a_locale',
        timezone: 'Mars/OlympusMons',
      },
      'strict',
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_INTERACTION_CONTEXT');
      expect(result.error.issues).toContain('locale is invalid');
      expect(result.error.issues).toContain('timezone is invalid');
    }
  });

  test('sanitizes invalid fields while keeping valid fields in sanitize mode', () => {
    expect(
      normalizeInteractionContextInput(
        {
          language: 'en-US',
          timezone: 'Mars/OlympusMons',
        },
        'sanitize',
      ),
    ).toEqual({
      success: true,
      data: {
        language: 'en',
      },
      issues: [
        {
          field: 'timezone',
          message: 'timezone is invalid',
        },
      ],
    });
  });

  test('extracts legacy clientInfo locale/timezone as compatibility input', () => {
    expect(
      extractLegacyClientInfoInteractionContext(
        {
          clientInfo: {
            locale: 'pt-br',
            timezone: 'America/New_York',
          },
        },
        'sanitize',
      ),
    ).toEqual({
      success: true,
      data: {
        locale: 'pt-BR',
        timezone: 'America/New_York',
      },
      issues: [],
    });
  });

  test('prefers explicit values over session/contact/channel fallbacks', () => {
    const resolved = resolveInteractionContext({
      explicit: {
        timezone: 'America/New_York',
      },
      sessionPreference: {
        language: 'fr',
        locale: 'fr-FR',
        timezone: 'Europe/Paris',
        source: 'session',
        confidence: 'high',
        updatedAt: '2026-04-15T00:00:00.000Z',
      },
      contactPreference: {
        language: 'es',
        timezone: 'Europe/Madrid',
      },
      channelHint: {
        locale: 'de-DE',
      },
      resolvedAt: new Date('2026-04-16T00:00:00.000Z'),
    });

    expect(resolved.current).toEqual({
      language: 'fr',
      locale: 'fr-FR',
      timezone: 'America/New_York',
      source: 'message',
      confidence: 'explicit',
      resolvedAt: '2026-04-16T00:00:00.000Z',
    });
    expect(resolved.preference).toEqual({
      language: 'fr',
      locale: 'fr-FR',
      timezone: 'America/New_York',
      source: 'message',
      confidence: 'explicit',
      updatedAt: '2026-04-16T00:00:00.000Z',
    });
    expect(resolved.aliases).toEqual({
      _language: 'fr',
      _locale: 'fr-FR',
      _timezone: 'America/New_York',
    });
  });

  test('seeds preference from contact and channel hints when the session is silent', () => {
    const resolved = resolveInteractionContext({
      contactPreference: {
        language: 'it',
        timezone: 'Europe/Rome',
      },
      channelHint: {
        locale: 'it-IT',
      },
      resolvedAt: new Date('2026-04-16T00:00:00.000Z'),
    });

    expect(resolved.current).toEqual({
      language: 'it',
      locale: 'it-IT',
      timezone: 'Europe/Rome',
      source: 'contact',
      confidence: 'high',
      resolvedAt: '2026-04-16T00:00:00.000Z',
    });
    expect(resolved.preference).toEqual({
      language: 'it',
      locale: 'it-IT',
      timezone: 'Europe/Rome',
      source: 'contact',
      confidence: 'high',
      updatedAt: '2026-04-16T00:00:00.000Z',
    });
  });

  test('keeps seeded preference fields when an explicit turn overrides only one dimension', () => {
    const resolved = resolveInteractionContext({
      explicit: {
        locale: 'es-MX',
      },
      contactPreference: {
        language: 'fr',
        timezone: 'Europe/Paris',
      },
      resolvedAt: new Date('2026-04-16T00:00:00.000Z'),
    });

    expect(resolved.current).toEqual({
      language: 'fr',
      locale: 'es-MX',
      timezone: 'Europe/Paris',
      source: 'message',
      confidence: 'explicit',
      resolvedAt: '2026-04-16T00:00:00.000Z',
    });
    expect(resolved.preference).toEqual({
      language: 'fr',
      locale: 'es-MX',
      timezone: 'Europe/Paris',
      source: 'message',
      confidence: 'explicit',
      updatedAt: '2026-04-16T00:00:00.000Z',
    });
  });

  test('infers a current-turn language hint from obvious non-English text', () => {
    expect(inferInteractionContextFromUserMessage('Hola, necesito ayuda con mi reserva')).toEqual({
      language: 'es',
      source: 'message',
      confidence: 'medium',
    });
  });

  test('does not promote medium-confidence channel language hints to preference', () => {
    const resolved = resolveInteractionContext({
      messageHint: {
        language: 'es',
        locale: 'es-MX',
        source: 'channel',
        confidence: 'medium',
      },
      resolvedAt: new Date('2026-04-16T00:00:00.000Z'),
    });

    expect(resolved.current).toEqual({
      language: 'es',
      locale: 'es-MX',
      timezone: null,
      source: 'channel',
      confidence: 'medium',
      resolvedAt: '2026-04-16T00:00:00.000Z',
    });
    expect(resolved.preference).toBeUndefined();
  });

  test('ignores low-confidence fallback language detection', () => {
    expect(inferInteractionContextFromUserMessage('Need help with my booking')).toBeUndefined();
  });

  test('prefers current inferred language for parsing when inherited locale conflicts', () => {
    const sessionData = {
      values: {
        session: {
          interaction: {
            current: {
              language: 'es',
              locale: 'fr-FR',
              timezone: 'Europe/Paris',
              source: 'message',
              confidence: 'medium',
              resolvedAt: '2026-04-16T00:00:00.000Z',
            },
            preference: {
              language: 'fr',
              locale: 'fr-FR',
              timezone: 'Europe/Paris',
              source: 'contact',
              confidence: 'high',
              updatedAt: '2026-04-15T00:00:00.000Z',
            },
          },
        },
      },
    };

    expect(getCurrentInteractionParsingLocale(sessionData, 'en')).toBe('es');
  });

  test('backfills session preference from legacy aliases when canonical state exists but is empty', () => {
    const sessionData = {
      values: {
        _locale: 'fr-CA',
        session: {
          interaction: {
            current: {
              language: null,
              locale: null,
              timezone: null,
              source: 'default',
              confidence: 'low',
              resolvedAt: '2026-04-16T00:00:00.000Z',
            },
          },
        },
      },
    };

    const nextState = resolveAndApplyInteractionContextToSessionData({
      sessionData,
      resolvedAt: new Date('2026-04-16T00:00:00.000Z'),
    });

    expect(nextState.current).toMatchObject({
      locale: 'fr-CA',
      source: 'session',
      confidence: 'high',
    });
    expect(nextState.preference).toMatchObject({
      locale: 'fr-CA',
      source: 'session',
      confidence: 'high',
    });
    expect(sessionData.values).toMatchObject({
      _locale: 'fr-CA',
    });
  });

  test('promotes repeated inferred language switches into session preference', () => {
    const resolved = resolveInteractionContext({
      messageHint: {
        language: 'es',
        source: 'message',
        confidence: 'high',
      },
      sessionCurrent: {
        language: 'es',
        locale: null,
        timezone: null,
        source: 'message',
        confidence: 'high',
        resolvedAt: '2026-04-15T00:00:00.000Z',
      },
      sessionPreference: {
        language: 'en',
        locale: 'en-US',
        timezone: 'America/New_York',
        source: 'session',
        confidence: 'high',
        updatedAt: '2026-04-14T00:00:00.000Z',
      },
      resolvedAt: new Date('2026-04-16T00:00:00.000Z'),
    });

    expect(resolved.current).toEqual({
      language: 'es',
      locale: 'en-US',
      timezone: 'America/New_York',
      source: 'message',
      confidence: 'high',
      resolvedAt: '2026-04-16T00:00:00.000Z',
    });
    expect(resolved.preference).toEqual({
      language: 'es',
      locale: 'en-US',
      timezone: 'America/New_York',
      source: 'message',
      confidence: 'high',
      updatedAt: '2026-04-16T00:00:00.000Z',
    });
  });
});

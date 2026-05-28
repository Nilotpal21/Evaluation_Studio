import { describe, expect, test } from 'vitest';
import { normalizeSpeechLanguageCode } from '../../services/voice/voice-language.js';

describe('voice language normalization', () => {
  test('normalizes gateway reported locale into language and locale', () => {
    expect(normalizeSpeechLanguageCode('ES-mx')).toEqual({
      language: 'es',
      locale: 'es-MX',
    });
  });

  test('normalizes bare language codes without inventing a locale', () => {
    expect(normalizeSpeechLanguageCode('es')).toEqual({
      language: 'es',
    });
  });

  test('ignores invalid or empty language codes', () => {
    expect(normalizeSpeechLanguageCode('')).toBeUndefined();
    expect(normalizeSpeechLanguageCode('not_a_locale')).toBeUndefined();
    expect(normalizeSpeechLanguageCode(undefined)).toBeUndefined();
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mockGetSupportedLanguagesAndVoices } = vi.hoisted(() => ({
  mockGetSupportedLanguagesAndVoices: vi.fn(),
}));

vi.mock('../../services/voice/jambonz-provisioning.service.js', () => ({
  getJambonzProvisioningService: vi.fn(() => ({
    getSupportedLanguagesAndVoices: mockGetSupportedLanguagesAndVoices,
  })),
}));

import {
  clearTtsLanguageResolutionCache,
  resolveTtsLanguageForVoiceTurn,
} from '../../services/voice/tts-language-resolver.js';

describe('resolveTtsLanguageForVoiceTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTtsLanguageResolutionCache();
  });

  test('keeps configured language when gateway reports no language', async () => {
    const result = await resolveTtsLanguageForVoiceTurn({
      ttsVendor: 'elevenlabs',
      ttsVoice: 'voice-en',
      configuredLanguage: 'en',
    });

    expect(result).toMatchObject({
      effectiveLanguage: 'en',
      reason: 'no_reported_language',
      languageChanged: false,
    });
    expect(mockGetSupportedLanguagesAndVoices).not.toHaveBeenCalled();
  });

  test('uses exact supported locale when configured voice is valid for it', async () => {
    mockGetSupportedLanguagesAndVoices.mockResolvedValue({
      tts: [
        { code: 'es', name: 'Spanish', voices: [{ value: 'voice-es', name: 'Spanish Voice' }] },
        { code: 'es-MX', name: 'Spanish Mexico', voices: [{ value: 'voice-en', name: 'Voice' }] },
      ],
      stt: [],
    });

    const result = await resolveTtsLanguageForVoiceTurn({
      ttsVendor: 'elevenlabs',
      ttsVoice: 'voice-en',
      configuredLanguage: 'en',
      tenantId: 'tenant-1',
      reportedLanguage: { language: 'es', locale: 'es-MX' },
    });

    expect(result).toMatchObject({
      effectiveLanguage: 'es-MX',
      reason: 'supported',
      languageChanged: true,
    });
    expect(mockGetSupportedLanguagesAndVoices).toHaveBeenCalledWith('elevenlabs', {
      label: 't:tenant-1',
    });
  });

  test('keeps configured language when voice is not available for reported language', async () => {
    mockGetSupportedLanguagesAndVoices.mockResolvedValue({
      tts: [
        {
          code: 'es-MX',
          name: 'Spanish Mexico',
          voices: [{ value: 'voice-es', name: 'Spanish Voice' }],
        },
      ],
      stt: [],
    });

    const result = await resolveTtsLanguageForVoiceTurn({
      ttsVendor: 'elevenlabs',
      ttsVoice: 'voice-en',
      configuredLanguage: 'en',
      tenantId: 'tenant-1',
      reportedLanguage: { language: 'es', locale: 'es-MX' },
    });

    expect(result).toMatchObject({
      effectiveLanguage: 'en',
      reason: 'unsupported',
      diagnosticCode: 'VOICE_TTS_LANGUAGE_UNSUPPORTED',
      languageChanged: false,
    });
  });

  test('keeps configured language when speech options lookup fails', async () => {
    mockGetSupportedLanguagesAndVoices.mockRejectedValue(new Error('gateway unavailable'));

    const result = await resolveTtsLanguageForVoiceTurn({
      ttsVendor: 'elevenlabs',
      ttsVoice: 'voice-en',
      configuredLanguage: 'en',
      tenantId: 'tenant-1',
      reportedLanguage: { language: 'fr' },
    });

    expect(result).toMatchObject({
      effectiveLanguage: 'en',
      reason: 'lookup_unavailable',
      diagnosticCode: 'VOICE_TTS_LANGUAGE_CAPABILITY_UNAVAILABLE',
      languageChanged: false,
    });
  });

  test('treats Orpheus as English-only without querying Jambonz', async () => {
    const result = await resolveTtsLanguageForVoiceTurn({
      ttsVendor: 'custom:orpheus',
      ttsVoice: 'hannah',
      configuredLanguage: 'en',
      tenantId: 'tenant-1',
      reportedLanguage: { language: 'es' },
    });

    expect(result).toMatchObject({
      effectiveLanguage: 'en',
      reason: 'unsupported',
      diagnosticCode: 'VOICE_TTS_LANGUAGE_UNSUPPORTED',
      languageChanged: false,
    });
    expect(mockGetSupportedLanguagesAndVoices).not.toHaveBeenCalled();
  });
});

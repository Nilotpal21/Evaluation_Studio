/**
 * Speech Providers API Client Tests
 *
 * Tests for fetchConfiguredSpeechProviders (STT/TTS filtering)
 * and fetchSpeechOptions (Jambonz proxy).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expectRejectedMessage } from './helpers/expect-rejected-message';

const mockApiFetch = vi.fn();

vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

describe('speech-providers', () => {
  let fetchConfiguredSpeechProviders: typeof import('../api/speech-providers').fetchConfiguredSpeechProviders;
  let fetchSpeechOptions: typeof import('../api/speech-providers').fetchSpeechOptions;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../api/speech-providers');
    fetchConfiguredSpeechProviders = mod.fetchConfiguredSpeechProviders;
    fetchSpeechOptions = mod.fetchSpeechOptions;
  });

  // ===========================================================================
  // fetchConfiguredSpeechProviders
  // ===========================================================================

  describe('fetchConfiguredSpeechProviders', () => {
    it('filters STT providers correctly', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          instances: [
            {
              id: '1',
              serviceType: 'deepgram',
              displayName: 'Deepgram',
              isDefault: false,
              isActive: true,
            },
            {
              id: '2',
              serviceType: 'google',
              displayName: 'Google',
              isDefault: false,
              isActive: true,
            },
            {
              id: '3',
              serviceType: 'elevenlabs',
              displayName: 'ElevenLabs',
              isDefault: false,
              isActive: true,
            },
          ],
        }),
      });

      const result = await fetchConfiguredSpeechProviders('tenant-1');
      expect(result.stt).toHaveLength(2);
      expect(result.stt.map((p) => p.serviceType)).toEqual(['deepgram', 'google']);
    });

    it('filters TTS providers correctly', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          instances: [
            {
              id: '1',
              serviceType: 'deepgram',
              displayName: 'Deepgram',
              isDefault: false,
              isActive: true,
            },
            {
              id: '2',
              serviceType: 'elevenlabs',
              displayName: 'ElevenLabs',
              isDefault: false,
              isActive: true,
            },
            {
              id: '3',
              serviceType: 'slack',
              displayName: 'Slack',
              isDefault: false,
              isActive: true,
            },
          ],
        }),
      });

      const result = await fetchConfiguredSpeechProviders('tenant-1');
      expect(result.tts).toHaveLength(2);
      expect(result.tts.map((p) => p.serviceType)).toEqual(['deepgram', 'elevenlabs']);
    });

    it('includes custom Orpheus in TTS providers', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          instances: [
            {
              id: '1',
              serviceType: 'custom:orpheus',
              displayName: 'Orpheus',
              isDefault: false,
              isActive: true,
            },
            {
              id: '2',
              serviceType: 'deepgram',
              displayName: 'Deepgram',
              isDefault: false,
              isActive: true,
            },
          ],
        }),
      });

      const result = await fetchConfiguredSpeechProviders('tenant-1');
      expect(result.tts.map((p) => p.serviceType)).toEqual(['custom:orpheus', 'deepgram']);
    });

    it('returns empty arrays on API error', async () => {
      mockApiFetch.mockResolvedValueOnce({ ok: false });

      const result = await fetchConfiguredSpeechProviders('tenant-1');
      expect(result).toEqual({ stt: [], tts: [] });
    });

    it('filters inactive providers even if the proxy returns them', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          instances: [
            {
              id: '1',
              serviceType: 'microsoft',
              displayName: 'Microsoft Speech',
              isDefault: false,
              isActive: true,
            },
            {
              id: '2',
              serviceType: 'gladia',
              displayName: 'Gladia',
              isDefault: false,
              isActive: false,
            },
          ],
        }),
      });

      const result = await fetchConfiguredSpeechProviders('tenant-1');
      expect(result.stt.map((provider) => provider.serviceType)).toEqual(['microsoft']);
    });

    it('handles serviceInstances key in response', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          serviceInstances: [
            { id: '1', serviceType: 'aws', displayName: 'AWS', isDefault: false, isActive: true },
          ],
        }),
      });

      const result = await fetchConfiguredSpeechProviders('tenant-1');
      expect(result.stt).toHaveLength(1);
      expect(result.tts).toHaveLength(1);
    });

    it('passes correct URL with tenantId', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ instances: [] }),
      });

      await fetchConfiguredSpeechProviders('my-tenant');
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/service-instances?tenantId=my-tenant&isActive=true',
      );
    });
  });

  // ===========================================================================
  // fetchSpeechOptions
  // ===========================================================================

  describe('fetchSpeechOptions', () => {
    it('returns tts and stt arrays from response', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tts: [{ code: 'en-US', name: 'English (US)', voices: [{ value: 'v1', name: 'Sarah' }] }],
          stt: [{ code: 'en', name: 'English' }],
        }),
      });

      const result = await fetchSpeechOptions('elevenlabs');
      expect(result.tts).toHaveLength(1);
      expect(result.tts[0].code).toBe('en-US');
      expect(result.tts[0].voices).toHaveLength(1);
      expect(result.stt).toHaveLength(1);
      expect(result.stt[0].code).toBe('en');
    });

    it('defaults missing tts/stt to empty arrays', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await fetchSpeechOptions('deepgram');
      expect(result).toEqual({ tts: [], stt: [] });
    });

    it('throws on API error', async () => {
      mockApiFetch.mockResolvedValueOnce({ ok: false });

      await expectRejectedMessage(
        fetchSpeechOptions('deepgram'),
        'Failed to fetch speech options for deepgram',
      );
    });

    it('encodes vendor name in URL', async () => {
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tts: [], stt: [] }),
      });

      await fetchSpeechOptions('vendor with spaces');
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/speech-options?vendor=vendor%20with%20spaces',
      );
    });
  });
});

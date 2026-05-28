import { describe, it, expect } from 'vitest';
import { KorevgVerbBuilder } from '../services/voice/korevg/verb-builder.js';

describe('KorevgVerbBuilder — Flux model support', () => {
  describe('TTS language overrides', () => {
    it('applies per-verb TTS language without changing the configured default', () => {
      const builder = new KorevgVerbBuilder({
        ttsVendor: 'elevenlabs',
        ttsVoice: 'voice-en',
        ttsLanguage: 'en',
      });

      const spanishSay = builder.say('hola', { ttsLanguage: 'es-MX' });
      const defaultSay = builder.say('hello');
      const streamingConfig = builder.buildStreamingConfig('/ws/korevg/test', {
        ttsLanguage: 'es-MX',
      });
      const defaultConfig = builder.buildStreamingConfig('/ws/korevg/test');

      expect(spanishSay.synthesizer?.language).toBe('es-MX');
      expect(defaultSay.synthesizer?.language).toBe('en');
      expect(streamingConfig.synthesizer?.language).toBe('es-MX');
      expect(streamingConfig.ttsStream).toEqual({ enable: true });
      expect(defaultConfig.synthesizer?.language).toBe('en');
      expect(defaultConfig.ttsStream).toEqual({ enable: true });
    });
  });

  describe('buildStreamingConfig()', () => {
    it('uses deepgramflux vendor and Flux EOT params when model is flux-general-en', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'deepgram',
        sttModel: 'flux-general-en',
      });
      const verb = builder.buildStreamingConfig('/ws/korevg/test');

      // Jambonz uses 'deepgramflux' as a separate vendor for Flux
      expect(verb.recognizer?.vendor).toBe('deepgramflux');

      const opts = verb.recognizer?.deepgramOptions;
      expect(opts).toBeDefined();
      expect(opts?.eotThreshold).toBe(0.7);
      expect(opts?.eotTimeoutMs).toBe(5000);
      // eagerEotThreshold omitted — causes duplicate responses without session support
      expect(opts?.eagerEotThreshold).toBeUndefined();
      // Must NOT have Nova params
      expect(opts?.endpointing).toBeUndefined();
      expect(opts?.utteranceEndMs).toBeUndefined();
    });

    it('uses deepgram vendor and Nova endpointing params when model is nova-3', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'deepgram',
        sttModel: 'nova-3',
      });
      const verb = builder.buildStreamingConfig('/ws/korevg/test');

      expect(verb.recognizer?.vendor).toBe('deepgram');

      const opts = verb.recognizer?.deepgramOptions;
      expect(opts?.endpointing).toBe(600);
      expect(opts?.utteranceEndMs).toBe(1500);
      // Must NOT have Flux params
      expect(opts?.eotThreshold).toBeUndefined();
    });

    it('applies conversation pause timeout to Nova endpointing params', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'deepgram',
        sttModel: 'nova-3',
        pauseTimeoutMs: 800,
      });
      const verb = builder.buildStreamingConfig('/ws/korevg/test');

      const opts = verb.recognizer?.deepgramOptions;
      expect(opts?.endpointing).toBe(800);
      expect(opts?.utteranceEndMs).toBe(800);
    });

    it('uses deepgram vendor and Nova endpointing when model is undefined', () => {
      const builder = new KorevgVerbBuilder({ sttVendor: 'deepgram' });
      const verb = builder.buildStreamingConfig('/ws/korevg/test');

      expect(verb.recognizer?.vendor).toBe('deepgram');
      expect(verb.recognizer?.deepgramOptions?.endpointing).toBe(600);
      expect(verb.recognizer?.deepgramOptions?.utteranceEndMs).toBe(1500);
    });

    it('does NOT use deepgramflux when vendor is not deepgram', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'google',
        sttModel: 'flux-general-en',
      });
      const verb = builder.buildStreamingConfig('/ws/korevg/test');

      // Non-deepgram vendor — should NOT switch to deepgramflux or carry Deepgram-only options
      expect(verb.recognizer?.vendor).toBe('google');
      expect(verb.recognizer?.deepgramOptions).toBeUndefined();
    });

    it('passes Google STT model through the recognizer payload', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'google',
        sttModel: 'chirp_3',
      });
      const verb = builder.buildStreamingConfig('/ws/korevg/test');

      expect(verb.recognizer?.vendor).toBe('google');
      expect(verb.recognizer?.model).toBe('chirp_3');
    });

    it('passes ElevenLabs TTS options through streaming synthesizer payloads', () => {
      const builder = new KorevgVerbBuilder({
        ttsVendor: 'elevenlabs',
        ttsVoice: 'voice-1',
        ttsOptions: {
          speed: 1.1,
          stability: 0.8,
          similarity_boost: 0.9,
          style: 0.2,
          use_speaker_boost: false,
        },
      });

      const verb = builder.buildStreamingConfig('/ws/korevg/test');

      expect(verb.synthesizer?.options).toMatchObject({
        speed: 1.1,
        stability: 0.8,
        similarity_boost: 0.9,
        style: 0.2,
        use_speaker_boost: false,
      });
      expect(verb.ttsStream).toEqual({ enable: true });
      expect(verb).not.toHaveProperty('autoStreamTts');
    });

    it('does not attach Deepgram-only options to Microsoft STT', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'microsoft',
        sttLanguage: 'zh-CN',
      });
      const verb = builder.buildStreamingConfig('/ws/korevg/test');

      expect(verb.recognizer).toEqual({
        vendor: 'microsoft',
        language: 'zh-CN',
      });
    });

    it('passes alternative recognition languages to Microsoft recognizer config', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'microsoft',
        sttLanguage: 'en-US',
        sttAlternativeLanguages: ['zh-CN', 'es-MX', 'en-US', 'zh-CN'],
      });

      expect(builder.buildStreamingConfig('/ws/korevg/test').recognizer).toEqual({
        vendor: 'microsoft',
        language: 'en-US',
        altLanguages: ['zh-CN', 'es-MX'],
      });
      expect(builder.gather({ input: ['speech'] }).recognizer).toMatchObject({
        vendor: 'microsoft',
        language: 'en-US',
        altLanguages: ['zh-CN', 'es-MX'],
      });
      expect(builder.buildConfig().recognizer).toMatchObject({
        vendor: 'microsoft',
        language: 'en-US',
        altLanguages: ['zh-CN', 'es-MX'],
      });
    });
  });

  describe('gather()', () => {
    it('uses deepgramflux vendor with Flux EOT params when flux is active', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'deepgram',
        sttModel: 'flux-general-en',
      });
      const verb = builder.gather({ prompt: 'test', input: ['speech'] });

      expect(verb.recognizer?.vendor).toBe('deepgramflux');
      expect(verb.recognizer?.deepgramOptions).toBeDefined();
      expect(verb.recognizer?.deepgramOptions?.eotThreshold).toBe(0.7);
    });

    it('applies conversation pause timeout to gather speech timeout', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'deepgram',
        sttModel: 'nova-3',
        pauseTimeoutMs: 800,
      });
      const verb = builder.gather({ prompt: 'test', input: ['speech'] });

      expect(verb.speechTimeout).toBe(1);
    });

    it('uses deepgram vendor without deepgramOptions when model is nova', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'deepgram',
        sttModel: 'nova-3',
      });
      const verb = builder.gather({ prompt: 'test', input: ['speech'] });

      expect(verb.recognizer?.vendor).toBe('deepgram');
      expect(verb.recognizer?.deepgramOptions).toBeUndefined();
    });
  });

  describe('buildConfig()', () => {
    it('uses deepgramflux vendor with Flux EOT params when flux is active', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'deepgram',
        sttModel: 'flux-general-en',
      });
      const verb = builder.buildConfig();

      expect(verb.recognizer?.vendor).toBe('deepgramflux');
      expect(verb.recognizer?.deepgramOptions).toBeDefined();
      expect(verb.recognizer?.deepgramOptions?.eotThreshold).toBe(0.7);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { KorevgVerbBuilder } from '../services/voice/korevg/verb-builder.js';
import { parseSttLatencyMs } from '../services/voice/korevg/korevg-session.js';

describe('STT Latency Measurement', () => {
  describe('buildStreamingConfig — notifySttLatency', () => {
    it('enables notifySttLatency for Flux models', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'deepgram',
        sttModel: 'flux-general-en',
      });
      const verb = builder.buildStreamingConfig('/ws/korevg/test');
      expect(verb.notifySttLatency).toBe(true);
    });

    it('enables notifySttLatency for Nova models', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'deepgram',
        sttModel: 'nova-3',
      });
      const verb = builder.buildStreamingConfig('/ws/korevg/test');
      expect(verb.notifySttLatency).toBe(true);
    });

    it('enables notifySttLatency for non-deepgram vendors', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'google',
        sttModel: 'default',
      });
      const verb = builder.buildStreamingConfig('/ws/korevg/test');
      expect(verb.notifySttLatency).toBe(true);
    });

    it('does NOT set notifySttLatency on buildConfig (non-streaming)', () => {
      const builder = new KorevgVerbBuilder({
        sttVendor: 'deepgram',
        sttModel: 'flux-general-en',
      });
      const verb = builder.buildConfig();
      expect(verb.notifySttLatency).toBeUndefined();
    });
  });

  describe('parseSttLatencyMs', () => {
    it('parses a single latency value', () => {
      expect(parseSttLatencyMs('340')).toBe(340);
    });

    it('averages multiple comma-separated latency values', () => {
      expect(parseSttLatencyMs('300,400')).toBe(350);
    });

    it('rounds the average to nearest integer', () => {
      expect(parseSttLatencyMs('100,200,300')).toBe(200);
      expect(parseSttLatencyMs('100,201')).toBe(151); // 150.5 rounds to 151
    });

    it('handles trailing comma (Jambonz accumulator format)', () => {
      // Jambonz appends commas: "340,520," — trailing comma should be ignored
      expect(parseSttLatencyMs('340,520,')).toBe(430);
    });

    it('returns undefined for undefined input', () => {
      expect(parseSttLatencyMs(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(parseSttLatencyMs('')).toBeUndefined();
    });

    it('returns undefined for only commas', () => {
      expect(parseSttLatencyMs(',,')).toBeUndefined();
    });

    it('handles single value with trailing comma', () => {
      expect(parseSttLatencyMs('250,')).toBe(250);
    });
  });
});

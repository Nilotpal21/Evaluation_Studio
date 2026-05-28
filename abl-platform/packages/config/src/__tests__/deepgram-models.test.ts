import { describe, it, expect } from 'vitest';
import {
  DEEPGRAM_STT_MODELS,
  DEFAULT_DEEPGRAM_STT_MODEL,
  FLUX_DEFAULTS,
  isFluxModel,
} from '../constants/deepgram-models.js';

describe('deepgram-models', () => {
  describe('DEEPGRAM_STT_MODELS', () => {
    it('contains expected models', () => {
      const ids = DEEPGRAM_STT_MODELS.map((m) => m.id);
      expect(ids).toContain('nova-3');
      expect(ids).toContain('nova-2');
      expect(ids).toContain('nova-2-phonecall');
      expect(ids).toContain('flux-general-en');
    });

    it('marks flux models with isFluxFamily', () => {
      const fluxModels = DEEPGRAM_STT_MODELS.filter((m) => m.isFluxFamily);
      expect(fluxModels).toHaveLength(1);
      expect(fluxModels[0].id).toBe('flux-general-en');
    });
  });

  describe('DEFAULT_DEEPGRAM_STT_MODEL', () => {
    it('is nova-3', () => {
      expect(DEFAULT_DEEPGRAM_STT_MODEL).toBe('nova-3');
    });
  });

  describe('isFluxModel', () => {
    it('returns true for flux-general-en', () => {
      expect(isFluxModel('flux-general-en')).toBe(true);
    });

    it('returns true for future flux variants', () => {
      expect(isFluxModel('flux-general-es')).toBe(true);
      expect(isFluxModel('flux-medical-en')).toBe(true);
    });

    it('returns false for nova models', () => {
      expect(isFluxModel('nova-3')).toBe(false);
      expect(isFluxModel('nova-2')).toBe(false);
      expect(isFluxModel('nova-2-phonecall')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isFluxModel('')).toBe(false);
    });

    it('returns false for enhanced/base models', () => {
      expect(isFluxModel('enhanced')).toBe(false);
      expect(isFluxModel('base')).toBe(false);
    });
  });

  describe('FLUX_DEFAULTS', () => {
    it('has valid eotThreshold range', () => {
      expect(FLUX_DEFAULTS.eotThreshold).toBeGreaterThanOrEqual(0.5);
      expect(FLUX_DEFAULTS.eotThreshold).toBeLessThanOrEqual(0.9);
    });

    it('has valid eotTimeoutMs range', () => {
      expect(FLUX_DEFAULTS.eotTimeoutMs).toBeGreaterThanOrEqual(500);
      expect(FLUX_DEFAULTS.eotTimeoutMs).toBeLessThanOrEqual(10000);
    });

    it('does not include eagerEotThreshold (causes duplicate responses)', () => {
      expect((FLUX_DEFAULTS as any).eagerEotThreshold).toBeUndefined();
    });
  });
});

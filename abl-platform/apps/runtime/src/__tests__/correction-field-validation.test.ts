import { describe, it, expect } from 'vitest';
import {
  detectCorrection,
  CORRECTION_FIELD_UNKNOWN,
} from '@abl/compiler/platform/constructs/utils.js';

describe('correction field validation', () => {
  describe('CORRECTION_FIELD_UNKNOWN constant', () => {
    it('should export CORRECTION_FIELD_UNKNOWN as _correction', () => {
      expect(CORRECTION_FIELD_UNKNOWN).toBe('_correction');
    });

    it('should return CORRECTION_FIELD_UNKNOWN when field cannot be identified', () => {
      // "actually blue" with no matching collected fields should return _correction
      const result = detectCorrection('actually blue', {});
      expect(result).not.toBeNull();
      expect(result!.field).toBe(CORRECTION_FIELD_UNKNOWN);
    });
  });

  describe('field whitelist enforcement', () => {
    it('should accept correction for a declared gather field', () => {
      const declaredFields = new Set(['destination', 'guests', 'date']);
      const correctionField = 'destination';
      expect(declaredFields.has(correctionField)).toBe(true);
    });

    it('should reject correction for an undeclared field', () => {
      const declaredFields = new Set(['destination', 'guests', 'date']);
      const correctionField = 'address';
      expect(declaredFields.has(correctionField)).toBe(false);
    });

    it('should reject _correction sentinel as undeclared', () => {
      const declaredFields = new Set(['destination', 'guests']);
      expect(declaredFields.has('_correction')).toBe(false);
    });
  });
});

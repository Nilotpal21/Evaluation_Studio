/**
 * UT-1: confidence/recognizer field threading.
 *
 * createSafePIIDetection defaults confidence=1.0 and accepts an
 * optional recognizer name. The factory is the single source of
 * truth for both fields, called from every pack and the registry's
 * detectAll method.
 */

import { describe, test, expect } from 'vitest';
import {
  createSafePIIDetection,
  detectPII,
  detectPIISelective,
} from '../../platform/security/pii-detector.js';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
} from '../../platform/security/pii-recognizer-registry.js';

describe('PIIDetection confidence + recognizer fields', () => {
  test('factory defaults confidence to 1.0', () => {
    const det = createSafePIIDetection('email', 0, 12);
    expect(det.confidence).toBe(1.0);
    expect(det.recognizer).toBeUndefined();
  });

  test('factory accepts confidence override', () => {
    const det = createSafePIIDetection('email', 0, 12, { confidence: 0.7 });
    expect(det.confidence).toBe(0.7);
  });

  test('factory accepts recognizer override', () => {
    const det = createSafePIIDetection('email', 0, 12, { recognizer: 'core-email' });
    expect(det.recognizer).toBe('core-email');
  });

  test('default registry detect threads recognizer name through', () => {
    const result = detectPII('Contact me at user@example.com');
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].confidence).toBe(1.0);
    // Default registry uses legacy 'builtin-*' names until core pack lands in 1b
    expect(result.detections[0].recognizer).toMatch(/^builtin-|^core-/);
  });

  test('selective detection preserves both fields', () => {
    const result = detectPIISelective('reach me at u@e.com');
    expect(result.detections[0].confidence).toBe(1.0);
    expect(result.detections[0].recognizer).toMatch(/^builtin-|^core-/);
  });

  test('custom recognizer threads its name', () => {
    const reg = new PIIRecognizerRegistry();
    reg.register(new RegexPIIRecognizer('custom-zipcode', ['zipcode'], /\b\d{5}\b/g, 'zipcode'), {
      permanent: true,
    });
    const dets = reg.detectAll('zip 94107 here');
    expect(dets).toHaveLength(1);
    expect(dets[0].recognizer).toBe('custom-zipcode');
    expect(dets[0].confidence).toBe(1.0);
  });
});

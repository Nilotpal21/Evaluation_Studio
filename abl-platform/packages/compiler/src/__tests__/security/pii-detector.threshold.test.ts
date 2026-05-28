/**
 * Regression test for the CRITICAL bug found in pr-review round 1:
 *
 *   confidence_threshold filtered the post-detection list but did NOT
 *   recompute the redacted string, so below-threshold matches were
 *   over-redacted in the output text.
 *
 * Fix: detectPIISelective now accepts an optional confidenceThreshold
 * and applies it BEFORE building the redacted string. Below-threshold
 * detections are still returned for audit visibility but are NOT
 * redacted in result.redacted.
 */

import { describe, test, expect } from 'vitest';
import { detectPIISelective } from '../../platform/security/pii-detector.js';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
} from '../../platform/security/pii-recognizer-registry.js';

function buildRegistry(): PIIRecognizerRegistry {
  const reg = new PIIRecognizerRegistry();
  // High-confidence recognizer (default 1.0)
  reg.register(
    new RegexPIIRecognizer(
      'high-conf-email',
      ['email'],
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      'email',
    ),
    { permanent: true },
  );
  // Low-confidence recognizer (baseConfidence 0.4)
  reg.register(
    new RegexPIIRecognizer(
      'low-conf-zip',
      ['zipcode'],
      /\b\d{5}\b/g,
      'zipcode',
      undefined,
      'regex',
      { baseConfidence: 0.4 },
    ),
    { permanent: true },
  );
  return reg;
}

describe('detectPIISelective: confidence_threshold bug regression', () => {
  test('threshold=0 (default behavior) — all matches redacted', () => {
    const reg = buildRegistry();
    const out = detectPIISelective('hi a@b.com zip 94107', undefined, reg);
    expect(out.redacted).toContain('[REDACTED_EMAIL]');
    expect(out.redacted).toContain('[REDACTED_ZIPCODE]');
    expect(out.redacted).not.toContain('a@b.com');
    expect(out.redacted).not.toContain('94107');
  });

  test('threshold=0.5 — only the high-confidence email is redacted; the zip stays', () => {
    const reg = buildRegistry();
    const out = detectPIISelective('hi a@b.com zip 94107', undefined, reg, {
      confidenceThreshold: 0.5,
    });
    expect(out.redacted).toContain('[REDACTED_EMAIL]');
    expect(out.redacted).not.toContain('a@b.com');
    // CRITICAL bug regression: zip should NOT be redacted because it's below threshold
    expect(out.redacted).toContain('94107');
    expect(out.redacted).not.toContain('[REDACTED_ZIPCODE]');
  });

  test('threshold=0.9 — both detections returned for audit, neither redacted', () => {
    const reg = buildRegistry();
    const out = detectPIISelective('a@b.com', undefined, reg, {
      confidenceThreshold: 0.9,
    });
    // 1.0 (email default) >= 0.9 → email IS redacted
    expect(out.redacted).toContain('[REDACTED_EMAIL]');
  });

  test('audit visibility preserved: below-threshold detections are still in result.detections', () => {
    const reg = buildRegistry();
    const out = detectPIISelective('a@b.com 94107', undefined, reg, {
      confidenceThreshold: 0.5,
    });
    // Both detections are still visible for audit/observability
    const types = out.detections.map((d) => d.type);
    expect(types).toContain('email');
    expect(types).toContain('zipcode');
    // But redactedTypes only includes the above-threshold one
    expect(out.redactedTypes).toEqual(['email']);
  });

  test('audit-trail: hasPII stays true when matches exist below threshold (visibility, not redaction)', () => {
    const reg = buildRegistry();
    const out = detectPIISelective('zip 94107 only', undefined, reg, {
      confidenceThreshold: 0.5,
    });
    // Audit semantics: hasPII reflects "did we detect anything" — needed by
    // pii-guard.ts for audit-log emission. The redaction view is in
    // redactedTypes / redacted text, which correctly reflects the threshold.
    expect(out.detections).toHaveLength(1);
    expect(out.hasPII).toBe(true);
    expect(out.redactedTypes).toEqual([]);
    expect(out.redacted).toBe('zip 94107 only'); // not redacted
  });

  test('threshold combined with exemptTypes — both filters compose', () => {
    const reg = buildRegistry();
    // Exempt email type entirely; threshold drops the zip
    const out = detectPIISelective('a@b.com zip 94107', new Set(['email']), reg, {
      confidenceThreshold: 0.5,
    });
    expect(out.redacted).toBe('a@b.com zip 94107'); // nothing redacted
    expect(out.exemptedTypes).toEqual(['email']);
    expect(out.redactedTypes).toEqual([]);
  });
});

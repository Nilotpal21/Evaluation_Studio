/**
 * INT-1/2/3/4: registry-bypass regression tests.
 *
 * The four entry-point helpers (detectPII, redactPII, containsPII,
 * detectPIISelective) now route to the singleton default registry when
 * no explicit registry is passed. The PII_BYPASS_FIX_ENABLED=false env
 * reverts the three wrapped surfaces (trace-scrubber, cel-functions,
 * action-executors) to the legacy bypass.
 *
 * INT-1: trace-scrubber surface
 * INT-2: cel-functions surface (contains_pii / detect_pii / redact_pii)
 * INT-3: action-executors surface (executeRedact / executeFix)
 * INT-4: entry-point default fallback (detectPII without registry)
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  detectPII,
  redactPII,
  containsPII,
  detectPIISelective,
} from '../../platform/security/pii-detector.js';
import { scrubToolCallData } from '../../platform/constructs/executors/trace-scrubber.js';
import { executeRedact, executeFix } from '../../platform/guardrails/action-executors.js';
import { evaluateCel } from '../../platform/constructs/cel-evaluator.js';

function withBypass<T>(value: 'true' | 'false' | undefined, fn: () => T): T {
  const prior = process.env.PII_BYPASS_FIX_ENABLED;
  if (value === undefined) delete process.env.PII_BYPASS_FIX_ENABLED;
  else process.env.PII_BYPASS_FIX_ENABLED = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.PII_BYPASS_FIX_ENABLED;
    else process.env.PII_BYPASS_FIX_ENABLED = prior;
  }
}

beforeEach(() => {
  delete process.env.PII_BYPASS_FIX_ENABLED;
});
afterEach(() => {
  delete process.env.PII_BYPASS_FIX_ENABLED;
});

describe('INT-4: entry-point default fallback', () => {
  test('detectPII without registry uses singleton (fix-enabled default)', () => {
    const out = detectPII('email u@e.com');
    expect(out.hasPII).toBe(true);
    expect(out.detections[0].type).toBe('email');
  });

  test('redactPII without registry uses singleton', () => {
    const out = redactPII('contact u@e.com please');
    expect(out).toContain('[REDACTED_EMAIL]');
  });

  test('containsPII without registry uses singleton', () => {
    expect(containsPII('u@e.com')).toBe(true);
    expect(containsPII('hello world')).toBe(false);
  });

  test('detectPIISelective without registry uses singleton', () => {
    const out = detectPIISelective('u@e.com is mine');
    expect(out.hasPII).toBe(true);
  });
});

describe('INT-1: trace-scrubber surface', () => {
  test('PII redacted by default (fix-enabled, no registry passed)', () => {
    const out = scrubToolCallData({ message: 'reach me at u@e.com' });
    expect(out.message).toContain('[REDACTED_EMAIL]');
  });

  test('PII_BYPASS_FIX_ENABLED=false bypasses detection', () => {
    const out = withBypass('false', () => scrubToolCallData({ message: 'reach me at u@e.com' }));
    expect(out.message).toBe('reach me at u@e.com');
  });
});

describe('INT-2: cel-functions surface', () => {
  test('contains_pii returns true by default', () => {
    expect(evaluateCel('abl.contains_pii(text)', { text: 'u@e.com' })).toBe(true);
  });

  test('redact_pii redacts by default', () => {
    expect(String(evaluateCel('abl.redact_pii(text)', { text: 'contact u@e.com' }))).toContain(
      '[REDACTED_EMAIL]',
    );
  });

  test('PII_BYPASS_FIX_ENABLED=false short-circuits CEL helpers', () => {
    withBypass('false', () => {
      expect(evaluateCel('abl.contains_pii(text)', { text: 'u@e.com' })).toBe(false);
      expect(evaluateCel('abl.redact_pii(text)', { text: 'u@e.com' })).toBe('u@e.com');
    });
  });
});

describe('INT-3: action-executors surface', () => {
  test('executeRedact pii mode redacts by default', () => {
    expect(executeRedact('u@e.com please', 'pii')).toContain('[REDACTED_EMAIL]');
  });

  test('executeFix redact_pii redacts by default', () => {
    expect(executeFix('u@e.com please', 'redact_pii')).toContain('[REDACTED_EMAIL]');
  });

  test('PII_BYPASS_FIX_ENABLED=false bypasses both', () => {
    withBypass('false', () => {
      expect(executeRedact('u@e.com', 'pii')).toBe('u@e.com');
      expect(executeFix('u@e.com', 'redact_pii')).toBe('u@e.com');
    });
  });
});

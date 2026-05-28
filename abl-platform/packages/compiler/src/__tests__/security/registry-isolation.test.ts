/**
 * INT-9: per-project recognizer-registry overlay isolation.
 *
 * Three projects with different pack selections + custom patterns must
 * each see only their own overlay; built-in entities (the `core` pack)
 * are shared because they're always part of the registry.
 *
 * Lives in compiler-side tests because the isolation is purely a
 * function of constructing fresh registries. The runtime ties this to
 * tenant + project via `createRecognizerRegistry()` and
 * `loadProjectPIIPatterns(...)`; INT-9 here pins the per-registry
 * invariant the runtime relies on.
 */

import { describe, test, expect } from 'vitest';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  registerPacks,
} from '../../platform/security/index.js';

function projectRegistry(
  packs: Parameters<typeof registerPacks>[0],
  customs: Array<[string, RegExp, string]>,
): PIIRecognizerRegistry {
  const reg = new PIIRecognizerRegistry();
  registerPacks(packs, reg);
  for (const [name, regex, type] of customs) {
    reg.register(new RegexPIIRecognizer(name, [type], regex, type, undefined, 'custom'));
  }
  return reg;
}

describe('INT-9: per-project registry overlay isolation', () => {
  // P-A (T1): core + eu, custom 'memberId'
  const pA = projectRegistry(['core', 'eu'], [['custom-member-id-A', /\bMA-\d{6}\b/g, 'memberId']]);
  // P-B (T1): core + medical, custom 'patientId'
  const pB = projectRegistry(
    ['core', 'medical'],
    [['custom-patient-id-B', /\bPT-\d{6}\b/g, 'patientId']],
  );
  // P-C (T2): core only
  const pC = projectRegistry(['core'], []);

  const text = 'IBAN GB82 WEST 1234 5698 7654 32, MA-123456, PT-654321, contact a@b.com';

  test('P-A sees IBAN + custom memberId; not patientId', () => {
    const types = new Set(pA.detectAll(text).map((d) => d.type));
    expect(types).toContain('email'); // shared core
    expect(types).toContain('eu_iban'); // eu pack
    expect(types).toContain('memberId'); // P-A custom
    expect(types.has('patientId')).toBe(false); // P-B's custom
    expect(types.has('med_mrn')).toBe(false); // medical pack not enabled
  });

  test('P-B sees medical entities + custom patientId; not memberId; not IBAN', () => {
    const types = new Set(pB.detectAll(text).map((d) => d.type));
    expect(types).toContain('email');
    expect(types).toContain('patientId');
    expect(types.has('memberId')).toBe(false);
    expect(types.has('eu_iban')).toBe(false);
  });

  test('P-C sees only core entities — neither pack-specific nor any custom', () => {
    const types = new Set(pC.detectAll(text).map((d) => d.type));
    expect(types).toContain('email');
    expect(types.has('eu_iban')).toBe(false);
    expect(types.has('memberId')).toBe(false);
    expect(types.has('patientId')).toBe(false);
    expect(types.has('med_mrn')).toBe(false);
  });

  test('mutating one registry does not affect another (no shared state)', () => {
    pA.register(new RegexPIIRecognizer('mutation-test', ['mut'], /MUT-\d+/g, 'mut'));
    expect(pA.get('mutation-test')).toBeDefined();
    expect(pB.get('mutation-test')).toBeUndefined();
    expect(pC.get('mutation-test')).toBeUndefined();
  });

  test('disableType is per-registry — one project can disable email without affecting others', () => {
    pA.disableType('email');
    expect(pA.detectAll('a@b.com').find((d) => d.type === 'email')).toBeUndefined();
    expect(pB.detectAll('a@b.com').find((d) => d.type === 'email')).toBeDefined();
    expect(pC.detectAll('a@b.com').find((d) => d.type === 'email')).toBeDefined();
    pA.enableType('email'); // restore for any later test ordering
  });
});

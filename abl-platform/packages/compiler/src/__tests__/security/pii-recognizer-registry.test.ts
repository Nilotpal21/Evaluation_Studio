/**
 * PII Recognizer Registry Tests
 *
 * Tests the pluggable PII recognizer system including:
 * - Registry CRUD operations (register, unregister, get, list)
 * - Permanent recognizer protection
 * - Multi-recognizer detection aggregation
 * - Exempt type filtering
 * - Error isolation between recognizers
 * - Max capacity eviction
 * - Built-in regex recognizer detection accuracy
 * - Default singleton lifecycle
 */
import { describe, test, expect, beforeEach } from 'vitest';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
  getDefaultPIIRecognizerRegistry,
  resetDefaultRegistry,
  type PIIRecognizer,
  type RecognizerTier,
} from '../../platform/security/pii-recognizer-registry.js';
import {
  getPIIRedactLabel,
  type PIIType,
  type PIIDetection,
} from '../../platform/security/pii-detector.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeStubRecognizer(
  name: string,
  tier: RecognizerTier = 'custom',
  types: PIIType[] = ['email'],
  detectFn?: (text: string) => PIIDetection[],
): PIIRecognizer {
  return {
    name,
    supportedTypes: types,
    tier,
    detect: detectFn ?? (() => []),
  };
}

function makeDetection(type: PIIType, value: string, start: number): PIIDetection {
  return { type, start, end: start + value.length, value };
}

// =============================================================================
// 1. REGISTER / UNREGISTER
// =============================================================================

describe('PIIRecognizerRegistry', () => {
  let registry: PIIRecognizerRegistry;

  beforeEach(() => {
    registry = new PIIRecognizerRegistry();
  });

  describe('register and unregister', () => {
    test('registers a recognizer and retrieves it by name', () => {
      const rec = makeStubRecognizer('test-rec');
      registry.register(rec);
      expect(registry.get('test-rec')).toBe(rec);
    });

    test('unregister removes a non-permanent recognizer', () => {
      const rec = makeStubRecognizer('removable');
      registry.register(rec);
      expect(registry.unregister('removable')).toBe(true);
      expect(registry.get('removable')).toBeUndefined();
    });

    test('unregister returns false for unknown name', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });

    test('re-registering overwrites existing recognizer', () => {
      const rec1 = makeStubRecognizer('dup', 'regex');
      const rec2 = makeStubRecognizer('dup', 'ml');
      registry.register(rec1);
      registry.register(rec2);
      expect(registry.get('dup')?.tier).toBe('ml');
      expect(registry.getRecognizerCount()).toBe(1);
    });
  });

  // =============================================================================
  // 2. PERMANENT RECOGNIZERS
  // =============================================================================

  describe('permanent recognizers', () => {
    test('permanent recognizer cannot be unregistered', () => {
      const rec = makeStubRecognizer('perm');
      registry.register(rec, { permanent: true });
      expect(registry.unregister('perm')).toBe(false);
      expect(registry.get('perm')).toBe(rec);
    });

    test('non-permanent recognizer can be unregistered', () => {
      const rec = makeStubRecognizer('temp');
      registry.register(rec, { permanent: false });
      expect(registry.unregister('temp')).toBe(true);
    });

    test('permanent flag defaults to false when not specified', () => {
      const rec = makeStubRecognizer('default-perm');
      registry.register(rec);
      expect(registry.unregister('default-perm')).toBe(true);
    });
  });

  // =============================================================================
  // 3. DETECT ALL
  // =============================================================================

  describe('detectAll', () => {
    test('returns detections from all registered recognizers', () => {
      const rec1 = makeStubRecognizer('email-rec', 'regex', ['email'], () => [
        makeDetection('email', 'a@b.com', 0),
      ]);
      const rec2 = makeStubRecognizer('phone-rec', 'regex', ['phone'], () => [
        makeDetection('phone', '555-123-4567', 20),
      ]);
      registry.register(rec1);
      registry.register(rec2);

      const results = registry.detectAll('some text');
      expect(results).toHaveLength(2);
      expect(results[0].type).toBe('email');
      expect(results[1].type).toBe('phone');
    });

    test('returns empty array when no recognizers are registered', () => {
      expect(registry.detectAll('hello world')).toEqual([]);
    });

    test('returns empty array when recognizers find nothing', () => {
      const rec = makeStubRecognizer('noop', 'regex', ['email'], () => []);
      registry.register(rec);
      expect(registry.detectAll('no pii here')).toEqual([]);
    });

    test('filters detections by exemptTypes', () => {
      const rec = makeStubRecognizer('multi', 'regex', ['email', 'phone'], () => [
        makeDetection('email', 'a@b.com', 0),
        makeDetection('phone', '555-0000', 10),
      ]);
      registry.register(rec);

      const results = registry.detectAll('text', new Set<PIIType>(['email']));
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phone');
    });

    test('exemptTypes as empty set does not filter anything', () => {
      const rec = makeStubRecognizer('e', 'regex', ['email'], () => [
        makeDetection('email', 'x@y.com', 0),
      ]);
      registry.register(rec);
      const results = registry.detectAll('text', new Set<PIIType>());
      expect(results).toHaveLength(1);
    });

    test('exemptTypes filters all types when all are exempt', () => {
      const rec = makeStubRecognizer('e', 'regex', ['email'], () => [
        makeDetection('email', 'x@y.com', 0),
      ]);
      registry.register(rec);
      const results = registry.detectAll('text', new Set<PIIType>(['email']));
      expect(results).toHaveLength(0);
    });

    test('disabled types are suppressed even when a recognizer detects them', () => {
      const rec = makeStubRecognizer('phone-rec', 'regex', ['phone'], () => [
        makeDetection('phone', '555-123-4567', 0),
      ]);
      registry.register(rec);
      registry.disableType('phone');

      expect(registry.detectAll('Call 555-123-4567')).toEqual([]);
      expect(registry.isTypeDisabled('phone')).toBe(true);

      registry.enableType('phone');
      expect(registry.detectAll('Call 555-123-4567')).toHaveLength(1);
    });

    test('custom recognizers are evaluated before built-ins', () => {
      const custom = makeStubRecognizer('custom-member-id', 'custom', ['MemberId'], () => [
        makeDetection('MemberId', 'AB1234567', 0),
      ]);
      const builtin = makeStubRecognizer('builtin-phone', 'regex', ['phone'], () => [
        makeDetection('phone', '1234567', 2),
      ]);
      registry.register(builtin);
      registry.register(custom);

      const results = registry.detectAll('AB1234567');

      expect(results.map((result) => result.type)).toEqual(['MemberId', 'phone']);
    });
  });

  // =============================================================================
  // 4. ERROR ISOLATION
  // =============================================================================

  describe('error isolation', () => {
    test('error in one recognizer does not break others', () => {
      const badRec = makeStubRecognizer('bad', 'custom', ['email'], () => {
        throw new Error('recognizer crashed');
      });
      const goodRec = makeStubRecognizer('good', 'regex', ['phone'], () => [
        makeDetection('phone', '555-1234567', 0),
      ]);
      registry.register(badRec);
      registry.register(goodRec);

      const results = registry.detectAll('text');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phone');
    });

    test('non-Error throw is handled gracefully', () => {
      const badRec = makeStubRecognizer('bad-string', 'custom', ['email'], () => {
        throw 'string error';
      });
      registry.register(badRec);

      const results = registry.detectAll('text');
      expect(results).toEqual([]);
    });
  });

  // =============================================================================
  // 5. MAX CAPACITY EVICTION
  // =============================================================================

  describe('max capacity eviction', () => {
    test('evicts oldest non-permanent recognizer when at max capacity', () => {
      // Fill to max (100)
      for (let i = 0; i < 100; i++) {
        registry.register(makeStubRecognizer(`rec-${i}`));
      }
      expect(registry.getRecognizerCount()).toBe(100);

      // Register one more — should evict rec-0
      registry.register(makeStubRecognizer('rec-100'));
      expect(registry.getRecognizerCount()).toBe(100);
      expect(registry.get('rec-0')).toBeUndefined();
      expect(registry.get('rec-100')).toBeDefined();
    });

    test('eviction skips permanent recognizers', () => {
      // Register permanent first
      registry.register(makeStubRecognizer('perm-0'), { permanent: true });

      // Fill remaining 99 slots
      for (let i = 1; i < 100; i++) {
        registry.register(makeStubRecognizer(`rec-${i}`));
      }
      expect(registry.getRecognizerCount()).toBe(100);

      // Register one more — should evict rec-1 (first non-permanent), not perm-0
      registry.register(makeStubRecognizer('rec-overflow'));
      expect(registry.get('perm-0')).toBeDefined();
      expect(registry.get('rec-1')).toBeUndefined();
      expect(registry.get('rec-overflow')).toBeDefined();
    });

    test('re-registering existing name does not trigger eviction', () => {
      for (let i = 0; i < 100; i++) {
        registry.register(makeStubRecognizer(`rec-${i}`));
      }
      // Re-register rec-0 — should NOT evict anything
      registry.register(makeStubRecognizer('rec-0', 'ml'));
      expect(registry.getRecognizerCount()).toBe(100);
      expect(registry.get('rec-0')?.tier).toBe('ml');
      expect(registry.get('rec-1')).toBeDefined();
    });
  });

  // =============================================================================
  // 6. LIST AND COUNT
  // =============================================================================

  describe('listRecognizers and getRecognizerCount', () => {
    test('listRecognizers returns correct info for all registered', () => {
      registry.register(makeStubRecognizer('a', 'regex', ['email']));
      registry.register(makeStubRecognizer('b', 'ml', ['phone', 'ssn']));

      const list = registry.listRecognizers();
      expect(list).toHaveLength(2);
      expect(list).toEqual(
        expect.arrayContaining([
          { name: 'a', tier: 'regex', types: ['email'] },
          { name: 'b', tier: 'ml', types: ['phone', 'ssn'] },
        ]),
      );
    });

    test('listRecognizers returns empty array when none registered', () => {
      expect(registry.listRecognizers()).toEqual([]);
    });

    test('getRecognizerCount tracks additions and removals', () => {
      expect(registry.getRecognizerCount()).toBe(0);
      registry.register(makeStubRecognizer('x'));
      expect(registry.getRecognizerCount()).toBe(1);
      registry.register(makeStubRecognizer('y'));
      expect(registry.getRecognizerCount()).toBe(2);
      registry.unregister('x');
      expect(registry.getRecognizerCount()).toBe(1);
    });
  });

  // =============================================================================
  // 7. REGEX PII RECOGNIZER
  // =============================================================================

  describe('RegexPIIRecognizer', () => {
    test('detects matches using regex pattern', () => {
      const rec = new RegexPIIRecognizer(
        'test-email',
        ['email'],
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        'email',
      );
      const results = rec.detect('Contact user@example.com today');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('email');
      expect(results[0].value).toBe('[REDACTED_EMAIL]');
      expect(results[0].start).toBe(8);
      expect(results[0].end).toBe(24);
    });

    test('can register a regex recognizer as a custom tier', () => {
      const rec = new RegexPIIRecognizer(
        'custom-member-id',
        ['MemberId'],
        /\b[A-Z]{2}\d{6}\b/g,
        'MemberId',
        undefined,
        'custom',
      );

      expect(rec.tier).toBe('custom');
      expect(rec.detect('ID AB123456')).toMatchObject([
        { type: 'MemberId', value: '[REDACTED_MEMBER_ID]' },
      ]);
    });

    test('applies validator and skips non-matching', () => {
      const rec = new RegexPIIRecognizer(
        'test-ip',
        ['ip_address'],
        /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
        'ip_address',
        (match: string) => {
          const parts = match.split('.');
          return parts.every((p) => {
            const n = parseInt(p, 10);
            return n >= 0 && n <= 255;
          });
        },
      );
      // Valid IP
      expect(rec.detect('IP: 192.168.1.1')).toHaveLength(1);
      // Invalid IP (999)
      expect(rec.detect('IP: 999.999.999.999')).toHaveLength(0);
    });

    test('returns empty when no matches', () => {
      const rec = new RegexPIIRecognizer('test-ssn', ['ssn'], /\b(\d{3}-\d{2}-\d{4})\b/g, 'ssn');
      expect(rec.detect('no ssn here')).toEqual([]);
    });

    test('detects multiple matches in same text', () => {
      const rec = new RegexPIIRecognizer(
        'test-email-multi',
        ['email'],
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        'email',
      );
      const results = rec.detect('a@b.com and c@d.com');
      expect(results).toHaveLength(2);
      expect(results[0].value).toBe('[REDACTED_EMAIL]');
      expect(results[1].value).toBe('[REDACTED_EMAIL]');
    });
  });

  // =============================================================================
  // 8. BUILT-IN RECOGNIZERS
  // =============================================================================

  describe('registerBuiltInRecognizers', () => {
    let builtInRegistry: PIIRecognizerRegistry;

    beforeEach(() => {
      builtInRegistry = new PIIRecognizerRegistry();
      registerBuiltInRecognizers(builtInRegistry);
    });

    test('registers 5 built-in recognizers', () => {
      expect(builtInRegistry.getRecognizerCount()).toBe(5);
    });

    test('all built-in recognizers are permanent', () => {
      const list = builtInRegistry.listRecognizers();
      for (const rec of list) {
        expect(builtInRegistry.unregister(rec.name)).toBe(false);
      }
    });

    test('built-in email recognizer detects email', () => {
      const results = builtInRegistry.detectAll('Send to alice@example.com');
      const emails = results.filter((d) => d.type === 'email');
      expect(emails).toHaveLength(1);
      expect(emails[0].value).toBe('[REDACTED_EMAIL]');
    });

    test('built-in phone recognizer detects US phone', () => {
      const results = builtInRegistry.detectAll('Call (555) 123-4567 now');
      const phones = results.filter((d) => d.type === 'phone');
      expect(phones).toHaveLength(1);
    });

    test('built-in SSN recognizer detects SSN', () => {
      const results = builtInRegistry.detectAll('SSN: 123-45-6789');
      const ssns = results.filter((d) => d.type === 'ssn');
      expect(ssns).toHaveLength(1);
      expect(ssns[0].value).toBe('[REDACTED_SSN]');
    });

    test('built-in credit card recognizer detects valid card number', () => {
      // 4111 1111 1111 1111 is a valid Luhn test number
      const results = builtInRegistry.detectAll('Card: 4111 1111 1111 1111');
      const cards = results.filter((d) => d.type === 'credit_card');
      expect(cards).toHaveLength(1);
    });

    test('built-in credit card recognizer rejects invalid Luhn number', () => {
      const results = builtInRegistry.detectAll('Card: 1234 5678 9012 3456');
      const cards = results.filter((d) => d.type === 'credit_card');
      expect(cards).toHaveLength(0);
    });

    test('built-in IP address recognizer detects valid IPv4', () => {
      const results = builtInRegistry.detectAll('Server at 10.0.0.1');
      const ips = results.filter((d) => d.type === 'ip_address');
      expect(ips).toHaveLength(1);
      expect(ips[0].value).toBe('[REDACTED_IP]');
    });

    test('built-in IP address recognizer rejects out-of-range octets', () => {
      const results = builtInRegistry.detectAll('Invalid: 300.400.500.600');
      const ips = results.filter((d) => d.type === 'ip_address');
      expect(ips).toHaveLength(0);
    });
  });

  // =============================================================================
  // 9. DEFAULT SINGLETON
  // =============================================================================

  describe('default registry singleton', () => {
    beforeEach(() => {
      resetDefaultRegistry();
    });

    test('getDefaultPIIRecognizerRegistry returns a registry with built-in recognizers', () => {
      const reg = getDefaultPIIRecognizerRegistry();
      expect(reg.getRecognizerCount()).toBe(5);
    });

    test('getDefaultPIIRecognizerRegistry returns same instance on repeated calls', () => {
      const reg1 = getDefaultPIIRecognizerRegistry();
      const reg2 = getDefaultPIIRecognizerRegistry();
      expect(reg1).toBe(reg2);
    });

    test('resetDefaultRegistry causes a new instance to be created', () => {
      const reg1 = getDefaultPIIRecognizerRegistry();
      resetDefaultRegistry();
      const reg2 = getDefaultPIIRecognizerRegistry();
      expect(reg1).not.toBe(reg2);
    });

    test('default registry detects mixed PII types', () => {
      const reg = getDefaultPIIRecognizerRegistry();
      const results = reg.detectAll('Email: test@x.com, SSN: 123-45-6789');
      const types = new Set(results.map((d) => d.type));
      expect(types.has('email')).toBe(true);
      expect(types.has('ssn')).toBe(true);
    });
  });

  // =============================================================================
  // 10. CUSTOM RECOGNIZER INTEGRATION
  // =============================================================================

  describe('custom recognizer integration', () => {
    test('custom recognizer integrates with built-in recognizers', () => {
      registerBuiltInRecognizers(registry);

      // Add a custom recognizer for a hypothetical "employee_id" detected as email type
      const customRec: PIIRecognizer = {
        name: 'custom-employee-id',
        supportedTypes: ['email'],
        tier: 'custom',
        detect(text: string): PIIDetection[] {
          const detections: PIIDetection[] = [];
          const re = /EMP-\d{6}/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            detections.push({
              type: 'email', // using email as the closest built-in type
              start: m.index,
              end: m.index + m[0].length,
              value: m[0],
            });
          }
          return detections;
        },
      };
      registry.register(customRec);

      const results = registry.detectAll('Employee EMP-123456 email: hr@co.com');
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((d) => d.value === getPIIRedactLabel(d.type))).toBe(true);
    });
  });
});

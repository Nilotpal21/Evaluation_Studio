import { describe, it, expect } from 'vitest';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
} from '@abl/compiler/platform';
import {
  validateDimensions,
  mergeDimensions,
  mergeSessionDimensions,
  MAX_DIMENSION_KEYS,
  MAX_KEY_LENGTH,
  MAX_VALUE_BYTES,
} from '../custom-dimensions.js';

describe('custom-dimensions validation', () => {
  const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';

  function createContractRegistry(): PIIRecognizerRegistry {
    const registry = new PIIRecognizerRegistry();
    registry.register(
      new RegexPIIRecognizer(
        'custom-contract-id',
        ['ContractID'],
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        'ContractID',
        undefined,
        'custom',
      ),
    );
    return registry;
  }

  // ── Key format ───────────────────────────────────────────────
  describe('key format', () => {
    it('accepts valid alphanumeric keys', () => {
      const result = validateDimensions({ orderId: 'ORD-1', customerTier: 'gold' });
      expect(result.valid).toBe(true);
      expect(result.dimensions.get('orderId')).toBe('ORD-1');
      expect(result.dimensions.get('customerTier')).toBe('gold');
    });

    it('accepts keys with underscores', () => {
      const result = validateDimensions({ order_id: 'ORD-1' });
      expect(result.valid).toBe(true);
      expect(result.dimensions.get('order_id')).toBe('ORD-1');
    });

    it('rejects keys starting with a digit', () => {
      const result = validateDimensions({ '1bad': 'val' });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Invalid key format');
    });

    it('rejects keys starting with underscore', () => {
      const result = validateDimensions({ _hidden: 'val' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid key format');
    });

    it('rejects keys with hyphens', () => {
      const result = validateDimensions({ 'order-id': 'val' });
      expect(result.valid).toBe(false);
    });

    it('rejects empty string key', () => {
      const result = validateDimensions({ '': 'val' });
      expect(result.valid).toBe(false);
    });
  });

  // ── Key length ───────────────────────────────────────────────
  describe('key length', () => {
    it('accepts key at max length', () => {
      const key = 'a' + 'b'.repeat(MAX_KEY_LENGTH - 1);
      const result = validateDimensions({ [key]: 'val' });
      expect(result.valid).toBe(true);
    });

    it('rejects key exceeding max length', () => {
      const key = 'a' + 'b'.repeat(MAX_KEY_LENGTH);
      const result = validateDimensions({ [key]: 'val' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Key too long');
    });
  });

  // ── Value coercion ───────────────────────────────────────────
  describe('value coercion', () => {
    it('passes strings through', () => {
      const result = validateDimensions({ k: 'hello' });
      expect(result.dimensions.get('k')).toBe('hello');
    });

    it('coerces numbers to string', () => {
      const result = validateDimensions({ k: 42 });
      expect(result.dimensions.get('k')).toBe('42');
    });

    it('coerces booleans to "true"/"false"', () => {
      const result = validateDimensions({ a: true, b: false });
      expect(result.dimensions.get('a')).toBe('true');
      expect(result.dimensions.get('b')).toBe('false');
    });

    it('rejects objects', () => {
      const result = validateDimensions({ k: { nested: true } });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Cannot coerce');
    });

    it('rejects arrays', () => {
      const result = validateDimensions({ k: [1, 2, 3] });
      expect(result.valid).toBe(false);
    });

    it('rejects null', () => {
      const result = validateDimensions({ k: null });
      expect(result.valid).toBe(false);
    });

    it('rejects undefined', () => {
      const result = validateDimensions({ k: undefined });
      expect(result.valid).toBe(false);
    });

    it('rejects NaN', () => {
      const result = validateDimensions({ k: NaN });
      expect(result.valid).toBe(false);
    });

    it('rejects Infinity', () => {
      const result = validateDimensions({ k: Infinity });
      expect(result.valid).toBe(false);
    });
  });

  // ── Value size ───────────────────────────────────────────────
  describe('value size', () => {
    it('accepts value at max byte length', () => {
      const val = 'x'.repeat(MAX_VALUE_BYTES);
      const result = validateDimensions({ k: val });
      expect(result.valid).toBe(true);
    });

    it('rejects value exceeding max byte length', () => {
      const val = 'x'.repeat(MAX_VALUE_BYTES + 1);
      const result = validateDimensions({ k: val });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Value too large');
    });

    it('handles multi-byte characters correctly', () => {
      // Each emoji is ~4 bytes; 256 emojis = 1024 bytes = at limit
      const val = '😀'.repeat(256);
      const result = validateDimensions({ k: val });
      expect(result.valid).toBe(true);

      // One more pushes it over
      const over = '😀'.repeat(257);
      const resultOver = validateDimensions({ k: over });
      expect(resultOver.valid).toBe(false);
    });
  });

  // ── PII detection ────────────────────────────────────────────
  describe('PII detection', () => {
    it('rejects SSN patterns', () => {
      const result = validateDimensions({ k: 'ssn is 123-45-6789' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('PII detected');
    });

    it('rejects credit card patterns', () => {
      const result = validateDimensions({ k: 'card 4111-1111-1111-1111' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('PII detected');
    });

    it('rejects email patterns', () => {
      const result = validateDimensions({ k: 'contact user@example.com' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('PII detected');
    });

    it('rejects project custom patterns when a recognizer registry is supplied', () => {
      const result = validateDimensions({ contractId: rawContractId }, undefined, {
        piiRecognizerRegistry: createContractRegistry(),
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('PII detected');
    });

    it('rejects builtin phone patterns when a recognizer registry is supplied', () => {
      const registry = new PIIRecognizerRegistry();
      registerBuiltInRecognizers(registry);

      const result = validateDimensions({ phone: '555-123-4567' }, undefined, {
        piiRecognizerRegistry: registry,
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('PII detected');
    });

    it('accepts non-PII values', () => {
      const result = validateDimensions({ k: 'ORD-12345' });
      expect(result.valid).toBe(true);
    });
  });

  // ── Key count limit ──────────────────────────────────────────
  describe('key count limit', () => {
    it(`accepts up to ${MAX_DIMENSION_KEYS} keys`, () => {
      const input: Record<string, string> = {};
      for (let i = 0; i < MAX_DIMENSION_KEYS; i++) {
        input[`key${String(i).padStart(3, '0')}`] = `val${i}`;
      }
      const result = validateDimensions(input);
      expect(result.valid).toBe(true);
      expect(result.dimensions.size).toBe(MAX_DIMENSION_KEYS);
    });

    it(`rejects the ${MAX_DIMENSION_KEYS + 1}th key`, () => {
      const input: Record<string, string> = {};
      for (let i = 0; i < MAX_DIMENSION_KEYS + 1; i++) {
        input[`key${String(i).padStart(3, '0')}`] = `val${i}`;
      }
      const result = validateDimensions(input);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Key limit reached'))).toBe(true);
      expect(result.dimensions.size).toBe(MAX_DIMENSION_KEYS);
    });

    it('allows overwriting existing keys without counting as new', () => {
      const existing = new Map<string, string>();
      for (let i = 0; i < MAX_DIMENSION_KEYS; i++) {
        existing.set(`key${String(i).padStart(3, '0')}`, `old${i}`);
      }
      // Overwrite one existing key — should succeed
      const result = validateDimensions({ key000: 'updated' }, existing);
      expect(result.valid).toBe(true);
      expect(result.dimensions.get('key000')).toBe('updated');
    });
  });

  // ── Mixed errors — partial acceptance ────────────────────────
  describe('partial acceptance', () => {
    it('accepts good keys and rejects bad keys in the same input', () => {
      const result = validateDimensions({
        goodKey: 'fine',
        '1bad': 'nope',
        anotherGood: 'ok',
      });
      expect(result.valid).toBe(false);
      expect(result.dimensions.size).toBe(2);
      expect(result.dimensions.has('goodKey')).toBe(true);
      expect(result.dimensions.has('anotherGood')).toBe(true);
      expect(result.errors).toHaveLength(1);
    });
  });

  // ── mergeDimensions ──────────────────────────────────────────
  describe('mergeDimensions', () => {
    it('adds new keys to existing dimensions', () => {
      const existing = new Map([['a', '1']]);
      const result = mergeDimensions(existing, { b: '2' });
      expect(result.valid).toBe(true);
      expect(result.dimensions.get('a')).toBe('1');
      expect(result.dimensions.get('b')).toBe('2');
    });

    it('overwrites existing keys', () => {
      const existing = new Map([['a', 'old']]);
      const result = mergeDimensions(existing, { a: 'new' });
      expect(result.valid).toBe(true);
      expect(result.dimensions.get('a')).toBe('new');
    });

    it('preserves existing keys when incoming is invalid', () => {
      const existing = new Map([['a', '1']]);
      const result = mergeDimensions(existing, { '!bad': 'val' });
      expect(result.valid).toBe(false);
      expect(result.dimensions.get('a')).toBe('1');
      expect(result.dimensions.size).toBe(1);
    });
  });

  describe('mergeSessionDimensions', () => {
    it('blocks custom-pattern metadata when session PII policy is enabled', () => {
      const session = {
        customDimensions: new Map([['safe', 'ok']]),
        piiRecognizerRegistry: createContractRegistry(),
        piiRedactionConfig: { enabled: true },
      };

      const result = mergeSessionDimensions(session, { contractId: rawContractId });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('PII detected');
      expect(session.customDimensions).toEqual(new Map([['safe', 'ok']]));
    });

    it('allows metadata when session PII policy is disabled', () => {
      const session = {
        customDimensions: new Map([['safe', 'ok']]),
        piiRecognizerRegistry: createContractRegistry(),
        piiRedactionConfig: { enabled: false },
      };

      const result = mergeSessionDimensions(session, { contractId: rawContractId });

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(session.customDimensions.get('contractId')).toBe(rawContractId);
    });
  });
});

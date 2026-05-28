import { describe, it, expect } from 'vitest';
import {
  validateConfigOverrides,
  type ContractConfigKey,
} from '../module-release/config-overrides-validator.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function contractKey(key: string, opts?: { isSecret?: boolean }): ContractConfigKey {
  return { key, ...opts };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('validateConfigOverrides', () => {
  describe('valid overrides', () => {
    it('returns empty blocking and warnings for empty overrides', () => {
      const result = validateConfigOverrides({}, []);
      expect(result.blocking).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('accepts valid key/value pairs matching contract', () => {
      const result = validateConfigOverrides({ apiUrl: 'https://example.com', timeout: '30' }, [
        contractKey('apiUrl'),
        contractKey('timeout'),
      ]);
      expect(result.blocking).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('max keys limit (50)', () => {
    it('accepts exactly 50 keys', () => {
      const overrides: Record<string, string> = {};
      const keys: ContractConfigKey[] = [];
      for (let i = 0; i < 50; i++) {
        overrides[`key${i}`] = 'value';
        keys.push(contractKey(`key${i}`));
      }

      const result = validateConfigOverrides(overrides, keys);
      expect(result.blocking).toEqual([]);
    });

    it('blocks when exceeding 50 keys', () => {
      const overrides: Record<string, string> = {};
      const keys: ContractConfigKey[] = [];
      for (let i = 0; i < 51; i++) {
        overrides[`key${i}`] = 'value';
        keys.push(contractKey(`key${i}`));
      }

      const result = validateConfigOverrides(overrides, keys);
      expect(result.blocking).toContainEqual(expect.stringContaining('51 exceeds maximum of 50'));
    });
  });

  describe('max value size (1024 bytes)', () => {
    it('accepts a value of exactly 1024 bytes', () => {
      const value = 'a'.repeat(1024);
      const result = validateConfigOverrides({ data: value }, [contractKey('data')]);
      expect(result.blocking).toEqual([]);
    });

    it('blocks a value of 1025 bytes', () => {
      const value = 'a'.repeat(1025);
      const result = validateConfigOverrides({ data: value }, [contractKey('data')]);
      expect(result.blocking).toContainEqual(expect.stringContaining('1025 bytes'));
    });

    it('counts multi-byte UTF-8 characters correctly', () => {
      // Each emoji is 4 bytes in UTF-8. 256 emojis = 1024 bytes = OK
      const value256 = '\u{1F600}'.repeat(256);
      expect(Buffer.byteLength(value256, 'utf-8')).toBe(1024);

      const resultOk = validateConfigOverrides({ emoji: value256 }, [contractKey('emoji')]);
      expect(resultOk.blocking).toEqual([]);

      // 257 emojis = 1028 bytes = blocked
      const value257 = '\u{1F600}'.repeat(257);
      expect(Buffer.byteLength(value257, 'utf-8')).toBe(1028);

      const resultBlocked = validateConfigOverrides({ emoji: value257 }, [contractKey('emoji')]);
      expect(resultBlocked.blocking).toContainEqual(expect.stringContaining('1028 bytes'));
    });
  });

  describe('undeclared keys', () => {
    it('blocks a key not in the contract so ignored values cannot be persisted', () => {
      const result = validateConfigOverrides({ unknown: 'value' }, [contractKey('declared')]);
      expect(result.blocking).toContainEqual(expect.stringContaining('"unknown" is not declared'));
      expect(result.blocking[0]).toContain('cannot be set');
      expect(result.warnings).toEqual([]);
    });
  });

  describe('secret key rejection', () => {
    it('blocks a key declared as secret', () => {
      const result = validateConfigOverrides({ apiKey: 'my-secret' }, [
        contractKey('apiKey', { isSecret: true }),
      ]);
      expect(result.blocking).toContainEqual(
        expect.stringContaining('"apiKey" is declared as secret'),
      );
    });

    it('allows a non-secret key', () => {
      const result = validateConfigOverrides({ apiUrl: 'https://example.com' }, [
        contractKey('apiUrl', { isSecret: false }),
      ]);
      expect(result.blocking).toEqual([]);
    });
  });

  describe('template injection', () => {
    it('blocks a value containing {{', () => {
      const result = validateConfigOverrides({ url: 'http://{{host}}/api' }, [contractKey('url')]);
      expect(result.blocking).toContainEqual(expect.stringContaining('template syntax "{{"'));
    });

    it('allows a value with a single {', () => {
      const result = validateConfigOverrides({ json: '{"key": "value"}' }, [contractKey('json')]);
      expect(result.blocking).toEqual([]);
    });

    it('blocks {{env.FOO}} specifically', () => {
      const result = validateConfigOverrides({ config: '{{env.FOO}}' }, [contractKey('config')]);
      expect(result.blocking).toContainEqual(expect.stringContaining('template syntax'));
    });
  });

  describe('control characters', () => {
    it('blocks value with null character \\x00', () => {
      const result = validateConfigOverrides({ data: 'hello\x00world' }, [contractKey('data')]);
      expect(result.blocking).toContainEqual(expect.stringContaining('control characters'));
    });

    it('blocks value with vertical tab \\x0B', () => {
      const result = validateConfigOverrides({ data: 'hello\x0Bworld' }, [contractKey('data')]);
      expect(result.blocking).toContainEqual(expect.stringContaining('control characters'));
    });

    it('allows value with tab \\x09', () => {
      const result = validateConfigOverrides({ data: 'hello\tworld' }, [contractKey('data')]);
      expect(result.blocking).toEqual([]);
    });

    it('allows value with newline \\x0A', () => {
      const result = validateConfigOverrides({ data: 'hello\nworld' }, [contractKey('data')]);
      expect(result.blocking).toEqual([]);
    });

    it('allows value with carriage return \\x0D', () => {
      const result = validateConfigOverrides({ data: 'hello\rworld' }, [contractKey('data')]);
      expect(result.blocking).toEqual([]);
    });
  });

  describe('multiple violations', () => {
    it('reports all issues in one call', () => {
      const result = validateConfigOverrides(
        {
          secret: 'value',
          big: 'x'.repeat(1025),
          injected: '{{bad}}',
          ctrl: 'a\x00b',
          unknown: 'ignored',
        },
        [
          contractKey('secret', { isSecret: true }),
          contractKey('big'),
          contractKey('injected'),
          contractKey('ctrl'),
        ],
      );

      // Secret key blocked
      expect(result.blocking).toContainEqual(
        expect.stringContaining('"secret" is declared as secret'),
      );
      // Value too large
      expect(result.blocking).toContainEqual(expect.stringContaining('"big"'));
      // Template injection
      expect(result.blocking).toContainEqual(expect.stringContaining('template syntax'));
      // Control character
      expect(result.blocking).toContainEqual(expect.stringContaining('control characters'));
      // Undeclared key blocked
      expect(result.blocking).toContainEqual(expect.stringContaining('"unknown" is not declared'));
    });

    it('coalesces undeclared and secret keys as blocking errors', () => {
      const result = validateConfigOverrides(
        {
          undeclaredKey: 'fine',
          secretKey: 'leaked',
        },
        [contractKey('secretKey', { isSecret: true })],
      );

      expect(result.blocking).toContainEqual(expect.stringContaining('"undeclaredKey"'));
      expect(result.blocking).toContainEqual(expect.stringContaining('"secretKey"'));
      expect(result.warnings).toEqual([]);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
} from '../../platform/security/pii-recognizer-registry.js';
import { evaluateCel } from '../../platform/constructs/cel-evaluator.js';

describe('Guardrail CEL functions', () => {
  function celEval(
    expr: string,
    vars: Record<string, unknown> = {},
    options?: { piiRecognizerRegistry?: PIIRecognizerRegistry },
  ): unknown {
    return evaluateCel(expr, vars, options);
  }

  describe('abl.contains_pii', () => {
    it('should return true for text with email', () => {
      expect(celEval('abl.contains_pii(text)', { text: 'Contact john@example.com' })).toBe(true);
    });
    it('should return true for text with SSN', () => {
      expect(celEval('abl.contains_pii(text)', { text: 'SSN: 123-45-6789' })).toBe(true);
    });
    it('should return false for clean text', () => {
      expect(celEval('abl.contains_pii(text)', { text: 'Hello world' })).toBe(false);
    });
  });

  describe('abl.redact_pii', () => {
    it('should redact email addresses', () => {
      const result = celEval('abl.redact_pii(text)', { text: 'Email: john@example.com' });
      expect(result).not.toContain('john@example.com');
      expect(result).toContain('[REDACTED');
    });

    it('should redact custom project patterns when a recognizer registry is supplied', () => {
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

      const result = celEval(
        'abl.redact_pii(text)',
        { text: 'Contract: 780b4d1c-1166-487e-ae7a-27eedd12905b' },
        { piiRecognizerRegistry: registry },
      ) as string;

      expect(result).toContain('[REDACTED_CONTRACT_ID]');
      expect(result).not.toContain('780b4d1c-1166-487e-ae7a-27eedd12905b');
    });
  });

  describe('abl.matches_pattern', () => {
    it('should match a regex pattern', () => {
      expect(
        celEval('abl.matches_pattern(text, pattern)', {
          text: '<script>alert(1)</script>',
          pattern: '<script',
        }),
      ).toBe(true);
    });
    it('should not match a non-matching pattern', () => {
      expect(
        celEval('abl.matches_pattern(text, pattern)', {
          text: 'Hello world',
          pattern: '<script',
        }),
      ).toBe(false);
    });
  });

  describe('abl.not_matches_pattern', () => {
    it('should be negation of matches_pattern', () => {
      expect(
        celEval('abl.not_matches_pattern(text, pattern)', {
          text: 'Hello world',
          pattern: '<script',
        }),
      ).toBe(true);
    });
  });

  describe('abl.word_count', () => {
    it('should count words', () => {
      expect(celEval('abl.word_count(text)', { text: 'Hello beautiful world' })).toBe(3);
    });
    it('should handle empty string', () => {
      expect(celEval('abl.word_count(text)', { text: '' })).toBe(0);
    });
  });

  describe('abl.sentence_count', () => {
    it('should count sentences', () => {
      expect(celEval('abl.sentence_count(text)', { text: 'Hello. How are you? Fine!' })).toBe(3);
    });
  });

  describe('abl.contains_url', () => {
    it('should detect http URLs', () => {
      expect(celEval('abl.contains_url(text)', { text: 'Visit https://example.com' })).toBe(true);
    });
    it('should return false for no URLs', () => {
      expect(celEval('abl.contains_url(text)', { text: 'No links here' })).toBe(false);
    });
  });

  describe('abl.contains_email', () => {
    it('should detect email addresses', () => {
      expect(celEval('abl.contains_email(text)', { text: 'Mail me at test@example.com' })).toBe(
        true,
      );
    });
  });

  describe('abl.contains_code', () => {
    it('should detect code blocks', () => {
      expect(
        celEval('abl.contains_code(text)', { text: 'Here is code:\n```js\nconsole.log(1)\n```' }),
      ).toBe(true);
    });
  });

  describe('project-aware registry support', () => {
    it('should detect custom project patterns with abl.contains_pii', () => {
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

      expect(
        celEval(
          'abl.contains_pii(text)',
          { text: 'Contract 780b4d1c-1166-487e-ae7a-27eedd12905b' },
          { piiRecognizerRegistry: registry },
        ),
      ).toBe(true);
    });
  });
});

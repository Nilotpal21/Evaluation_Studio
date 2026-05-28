/**
 * Gather Extraction Pattern Tests
 *
 * Tests custom regex extraction from user messages using field-level
 * extraction_pattern. This enables XO 10/11 migration where entities
 * use regex-based extraction.
 */
import { describe, test, expect } from 'vitest';
import {
  extractByPattern,
  validateExtractionPattern,
} from '../platform/constructs/executors/gather-executor.js';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { parseAgentBasedABL } from '@abl/core';

describe('Gather Extraction Pattern', () => {
  // ===========================================================================
  // PATTERN EXTRACTION
  // ===========================================================================

  describe('extractByPattern', () => {
    test('extracts value matching full pattern (group 0)', () => {
      const result = extractByPattern('My policy is POL-123456-AB', 'POL-\\d{6}-[A-Z]{2}');
      expect(result).toBe('POL-123456-AB');
    });

    test('extracts specific capture group', () => {
      const result = extractByPattern('Employee ID: EMP-12345', 'EMP-(\\d{4,8})', 1);
      expect(result).toBe('12345');
    });

    test('returns null when no match', () => {
      const result = extractByPattern('I have no policy number', 'POL-\\d{6}-[A-Z]{2}');
      expect(result).toBeNull();
    });

    test('returns first match when multiple exist', () => {
      const result = extractByPattern(
        'Choose POL-111111-AA or POL-222222-BB',
        'POL-\\d{6}-[A-Z]{2}',
      );
      expect(result).toBe('POL-111111-AA');
    });

    test('returns null for invalid regex', () => {
      const result = extractByPattern('some text', '[invalid(regex');
      expect(result).toBeNull();
    });

    test('handles group index out of range', () => {
      const result = extractByPattern('EMP-12345', 'EMP-(\\d+)', 5);
      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // PATTERN VALIDATION (compile-time)
  // ===========================================================================

  describe('validateExtractionPattern', () => {
    test('accepts valid regex', () => {
      const result = validateExtractionPattern('POL-\\d{6}-[A-Z]{2}');
      expect(result.valid).toBe(true);
    });

    test('rejects invalid regex', () => {
      const result = validateExtractionPattern('[invalid(');
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });

    test('rejects nested quantifiers that can cause catastrophic backtracking', () => {
      const result = validateExtractionPattern('(a+)+$');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Nested quantifiers');
    });

    test('rejects pattern exceeding max length', () => {
      const result = validateExtractionPattern('a'.repeat(501));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum length');
    });

    test('accepts pattern at max length', () => {
      const result = validateExtractionPattern('a'.repeat(500));
      expect(result.valid).toBe(true);
    });
  });

  describe('compile-time safety', () => {
    test('rejects unsafe extraction_pattern while compiling GATHER fields', () => {
      const dsl = `
AGENT: ReDosAgent
GOAL: "Collect values"
GATHER:
  account:
    PROMPT: "What is your account?"
    TYPE: string
    extraction_pattern: "(a+)+$"
`;
      const parseResult = parseAgentBasedABL(dsl);
      expect(parseResult.errors).toHaveLength(0);
      expect(parseResult.document).toBeDefined();

      const output = compileABLtoIR([parseResult.document!]);
      expect(output.compilation_errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('unsafe extraction_pattern'),
          }),
        ]),
      );
    });
  });
});

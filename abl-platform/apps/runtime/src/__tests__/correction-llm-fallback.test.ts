/**
 * Tests for F2: Correction LLM fallback after invalid regex/sidecar field.
 *
 * These tests reproduce the correction validation and fallback branching
 * from flow-step-executor.ts lines 2426-2470 as isolated unit tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { CORRECTION_FIELD_UNKNOWN } from '@abl/compiler/platform/constructs/utils.js';

// Simulate the correction validation + LLM fallback logic
// exactly as it appears in flow-step-executor.ts
async function runCorrectionValidation(opts: {
  correctionField: string | undefined;
  correctionNewValue: string | undefined;
  correctionDetectionMethod: string;
  declaredFieldNames: Set<string>;
  llmClient: boolean;
  llmFallbackResult: { field: string; newValue: string } | null;
}): Promise<{
  correctionField: string | undefined;
  correctionNewValue: string | undefined;
  correctionDetectionMethod: string;
  llmCalled: boolean;
}> {
  let { correctionField, correctionNewValue, correctionDetectionMethod } = opts;
  const { declaredFieldNames, llmClient, llmFallbackResult } = opts;
  let llmCalled = false;

  if (correctionField && correctionNewValue !== undefined) {
    if (correctionField === CORRECTION_FIELD_UNKNOWN || !declaredFieldNames.has(correctionField)) {
      if (correctionDetectionMethod !== 'llm') {
        correctionField = undefined;
        correctionNewValue = undefined;

        // LLM fallback
        if (llmClient) {
          llmCalled = true;
          const llmFallback = llmFallbackResult;
          if (llmFallback && declaredFieldNames.has(llmFallback.field)) {
            correctionField = llmFallback.field;
            correctionNewValue = llmFallback.newValue;
            correctionDetectionMethod = 'llm';
          }
        }
      } else {
        // LLM was the original detector — no recursive retry
        correctionField = undefined;
        correctionNewValue = undefined;
      }
    }
  }

  return { correctionField, correctionNewValue, correctionDetectionMethod, llmCalled };
}

describe('F2: Correction LLM fallback', () => {
  const declaredFields = new Set(['destination', 'departure_date', 'budget', 'passengers']);

  describe('regex returns undeclared field → LLM fallback', () => {
    it('LLM returns valid declared field → correction applied', async () => {
      const result = await runCorrectionValidation({
        correctionField: 'unknown_field',
        correctionNewValue: 'Paris',
        correctionDetectionMethod: 'regex',
        declaredFieldNames: declaredFields,
        llmClient: true,
        llmFallbackResult: { field: 'destination', newValue: 'Paris' },
      });

      expect(result.correctionField).toBe('destination');
      expect(result.correctionNewValue).toBe('Paris');
      expect(result.correctionDetectionMethod).toBe('llm');
      expect(result.llmCalled).toBe(true);
    });

    it('LLM also returns undeclared field → correction skipped', async () => {
      const result = await runCorrectionValidation({
        correctionField: 'wrong_field',
        correctionNewValue: 'value',
        correctionDetectionMethod: 'regex',
        declaredFieldNames: declaredFields,
        llmClient: true,
        llmFallbackResult: { field: 'also_undeclared', newValue: 'something' },
      });

      expect(result.correctionField).toBeUndefined();
      expect(result.correctionNewValue).toBeUndefined();
      expect(result.llmCalled).toBe(true);
    });

    it('LLM returns null → correction skipped', async () => {
      const result = await runCorrectionValidation({
        correctionField: 'bad_field',
        correctionNewValue: 'value',
        correctionDetectionMethod: 'regex',
        declaredFieldNames: declaredFields,
        llmClient: true,
        llmFallbackResult: null,
      });

      expect(result.correctionField).toBeUndefined();
      expect(result.correctionNewValue).toBeUndefined();
      expect(result.llmCalled).toBe(true);
    });

    it('no LLM client → correction silently skipped', async () => {
      const result = await runCorrectionValidation({
        correctionField: 'unknown_field',
        correctionNewValue: 'value',
        correctionDetectionMethod: 'regex',
        declaredFieldNames: declaredFields,
        llmClient: false,
        llmFallbackResult: null,
      });

      expect(result.correctionField).toBeUndefined();
      expect(result.correctionNewValue).toBeUndefined();
      expect(result.llmCalled).toBe(false);
    });
  });

  describe('sidecar returns undeclared field → LLM fallback', () => {
    it('sidecar detects undeclared, LLM succeeds', async () => {
      const result = await runCorrectionValidation({
        correctionField: 'sidecar_wrong',
        correctionNewValue: '3',
        correctionDetectionMethod: 'sidecar',
        declaredFieldNames: declaredFields,
        llmClient: true,
        llmFallbackResult: { field: 'passengers', newValue: '3' },
      });

      expect(result.correctionField).toBe('passengers');
      expect(result.correctionNewValue).toBe('3');
      expect(result.correctionDetectionMethod).toBe('llm');
    });
  });

  describe('LLM was original detector', () => {
    it('LLM returned undeclared field → no recursive retry', async () => {
      const result = await runCorrectionValidation({
        correctionField: 'undeclared',
        correctionNewValue: 'value',
        correctionDetectionMethod: 'llm',
        declaredFieldNames: declaredFields,
        llmClient: true,
        llmFallbackResult: { field: 'destination', newValue: 'Paris' },
      });

      expect(result.correctionField).toBeUndefined();
      expect(result.correctionNewValue).toBeUndefined();
      expect(result.llmCalled).toBe(false); // No retry for LLM
    });
  });

  describe('CORRECTION_FIELD_UNKNOWN sentinel', () => {
    it('regex returns UNKNOWN sentinel → LLM fallback invoked', async () => {
      const result = await runCorrectionValidation({
        correctionField: CORRECTION_FIELD_UNKNOWN,
        correctionNewValue: 'new_value',
        correctionDetectionMethod: 'regex',
        declaredFieldNames: declaredFields,
        llmClient: true,
        llmFallbackResult: { field: 'budget', newValue: '500' },
      });

      expect(result.correctionField).toBe('budget');
      expect(result.correctionNewValue).toBe('500');
    });
  });

  describe('valid corrections pass through unchanged', () => {
    it('regex returns declared field → no fallback needed', async () => {
      const result = await runCorrectionValidation({
        correctionField: 'destination',
        correctionNewValue: 'London',
        correctionDetectionMethod: 'regex',
        declaredFieldNames: declaredFields,
        llmClient: true,
        llmFallbackResult: null,
      });

      expect(result.correctionField).toBe('destination');
      expect(result.correctionNewValue).toBe('London');
      expect(result.correctionDetectionMethod).toBe('regex');
      expect(result.llmCalled).toBe(false);
    });

    it('LLM returns declared field → passes through', async () => {
      const result = await runCorrectionValidation({
        correctionField: 'budget',
        correctionNewValue: '1000',
        correctionDetectionMethod: 'llm',
        declaredFieldNames: declaredFields,
        llmClient: true,
        llmFallbackResult: null,
      });

      expect(result.correctionField).toBe('budget');
      expect(result.correctionNewValue).toBe('1000');
      expect(result.llmCalled).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('no correction detected → passes through as undefined', async () => {
      const result = await runCorrectionValidation({
        correctionField: undefined,
        correctionNewValue: undefined,
        correctionDetectionMethod: 'regex',
        declaredFieldNames: declaredFields,
        llmClient: true,
        llmFallbackResult: null,
      });

      expect(result.correctionField).toBeUndefined();
      expect(result.llmCalled).toBe(false);
    });

    it('empty declared fields set → all corrections fail validation', async () => {
      const result = await runCorrectionValidation({
        correctionField: 'destination',
        correctionNewValue: 'Paris',
        correctionDetectionMethod: 'regex',
        declaredFieldNames: new Set(),
        llmClient: true,
        llmFallbackResult: { field: 'destination', newValue: 'Paris' },
      });

      // LLM fallback also can't find a valid field in empty set
      expect(result.correctionField).toBeUndefined();
      expect(result.llmCalled).toBe(true);
    });
  });
});

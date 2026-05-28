import { describe, expect, it } from 'vitest';
import {
  classifyBuildRetryPolicy,
  DEFAULT_BUILD_FIX_MAX_ROUNDS,
  extractDiagnosticCodes,
  STRUCTURAL_DIAGNOSTIC_FIX_MAX_ROUNDS,
} from '@/lib/arch-ai/build-retry-policy';

describe('build-retry-policy', () => {
  it('extracts and deduplicates diagnostic codes from compiler feedback messages', () => {
    expect(
      extractDiagnosticCodes([
        '[CO-02] COMPLETE references undeclared state.',
        'Line 18: [H-05] HANDOFF WHEN references unknown field.',
        '[CO-02] COMPLETE references undeclared state.',
        'No diagnostic code here.',
      ]),
    ).toEqual(['CO-02', 'H-05']);
  });

  it('keeps retries enabled for non-structural diagnostics', () => {
    const policy = classifyBuildRetryPolicy({
      messages: ['[SV-13] COMPLETE should be reachable from declared runtime state.'],
    });

    expect(policy).toMatchObject({
      diagnosticCodes: ['SV-13'],
      structuralCodes: [],
      retryable: true,
      fixMaxRounds: DEFAULT_BUILD_FIX_MAX_ROUNDS,
    });
    expect(policy.reason).toBeUndefined();
  });

  it('stops blind regeneration for structural completion and handoff diagnostics', () => {
    const policy = classifyBuildRetryPolicy({
      diagnosticCodes: ['CO-03', 'H-05', 'CO-03'],
      messages: ['[SV-13] COMPLETE should be reachable from declared runtime state.'],
    });

    expect(policy.diagnosticCodes).toEqual(['CO-03', 'H-05', 'SV-13']);
    expect(policy.structuralCodes).toEqual(['CO-03', 'H-05']);
    expect(policy.retryable).toBe(false);
    expect(policy.fixMaxRounds).toBe(STRUCTURAL_DIAGNOSTIC_FIX_MAX_ROUNDS);
    expect(policy.reason).toContain('CO-03, H-05');
  });

  it('keeps advisory handoff-context warnings retryable', () => {
    const policy = classifyBuildRetryPolicy({
      diagnosticCodes: ['H-03'],
    });

    expect(policy).toMatchObject({
      diagnosticCodes: ['H-03'],
      structuralCodes: [],
      retryable: true,
      fixMaxRounds: DEFAULT_BUILD_FIX_MAX_ROUNDS,
    });
  });
});

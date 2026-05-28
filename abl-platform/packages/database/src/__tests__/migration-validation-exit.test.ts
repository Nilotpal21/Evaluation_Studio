import { describe, expect, test } from 'vitest';
import { getBlockingValidationResults } from '../migrations/validation-exit.js';
import type { MigrationValidationRunResult } from '../migrations/types.js';

const result = (
  version: string,
  status: MigrationValidationRunResult['status'],
): MigrationValidationRunResult => ({
  version,
  description: `Migration ${version}`,
  status,
});

describe('getBlockingValidationResults', () => {
  test('blocks failed validation results in legacy and phased validation runs', () => {
    const results = [result('20260511_001', 'passed'), result('20260511_002', 'failed')];

    expect(getBlockingValidationResults(results)).toEqual([results[1]]);
    expect(getBlockingValidationResults(results, { phase: 'post_deploy' })).toEqual([results[1]]);
  });

  test('blocks pending migrations during phased validation runs', () => {
    const results = [result('20260511_001', 'pending'), result('20260511_002', 'passed')];

    expect(getBlockingValidationResults(results, { phase: 'post_deploy' })).toEqual([results[0]]);
  });

  test('allows pending migrations during legacy validation runs', () => {
    const results = [result('20260511_001', 'pending'), result('20260511_002', 'passed')];

    expect(getBlockingValidationResults(results)).toEqual([]);
  });
});

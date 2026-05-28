import type { MigrationPhaseOptions, MigrationValidationRunResult } from './types.js';

const BLOCKING_VALIDATION_STATUSES = new Set<MigrationValidationRunResult['status']>(['failed']);

export function getBlockingValidationResults(
  results: MigrationValidationRunResult[],
  options: MigrationPhaseOptions = {},
): MigrationValidationRunResult[] {
  return results.filter((result) => {
    if (BLOCKING_VALIDATION_STATUSES.has(result.status)) {
      return true;
    }

    return Boolean(options.phase) && result.status === 'pending';
  });
}

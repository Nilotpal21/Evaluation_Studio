import { describe, expect, it } from 'vitest';

import {
  isZeroTurnStartupFailureAdvisory,
  isZeroTurnStartupFailureText,
} from '../pipeline/engine/failure-advisory-detection.js';

describe('failure-advisory-detection', () => {
  it('treats zero-tool zero-output startup summaries as zero-turn startup failures', () => {
    expect(
      isZeroTurnStartupFailureText(
        'Model stalled at startup before any workspace inspection began — zero tool calls, zero output, 0 turns completed in 41s.',
        'Model/runtime bootstrap hang.',
      ),
    ).toBe(true);

    expect(
      isZeroTurnStartupFailureText(
        'Claude stalled after 41s of inactivity. Observed execution signals: progress=3, output=0, toolUse=0, shellCommands=0.',
      ),
    ).toBe(true);

    expect(
      isZeroTurnStartupFailureAdvisory({
        id: 'adv-startup-stall',
        stageName: 'Deep Scan',
        stageType: 'deep-scan',
        failureCategory: 'timeout',
        failureSignature: 'Deep Scan:timeout:model:startup-stall',
        retryCount: 0,
        sourceError: 'Claude stalled after 41s of inactivity (40s total elapsed, 0 turns)',
        generatedAt: new Date().toISOString(),
        summary:
          'Model stalled at startup before any workspace inspection began — zero tool calls, zero output, 0 turns completed in 41s.',
        suspectedCause: 'Model/runtime bootstrap hang: the CLI never emitted a first turn.',
        recommendedAction: 'switch-model',
        promptGuidance: null,
        operatorActions: [],
      }),
    ).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import { canEngageTestLock } from '../pipeline/slice-view.js';
import type { TestLock } from '../types.js';

describe('slice-view', () => {
  it('refuses to engage a test lock with no required tests', () => {
    const lock: TestLock = {
      requiredTests: [],
      regressionSuite: [],
      locked: false,
    };

    expect(canEngageTestLock(lock)).toBe(false);
  });

  it('engages a test lock only when every required test is passing', () => {
    const lock: TestLock = {
      requiredTests: [
        {
          testFile: 'packages/helix/src/__tests__/pipeline.test.ts',
          description: 'pipeline passes',
          status: 'passing',
          coversFindings: ['finding-1'],
          isNew: true,
        },
        {
          testFile: 'packages/helix/src/__tests__/parser.test.ts',
          description: 'parser passes',
          status: 'passing',
          coversFindings: ['finding-2'],
          isNew: true,
        },
      ],
      regressionSuite: ['packages/helix/src/__tests__/legacy.test.ts'],
      locked: false,
    };

    expect(canEngageTestLock(lock)).toBe(true);
  });

  it('keeps the lock open when any required test is not passing', () => {
    const lock: TestLock = {
      requiredTests: [
        {
          testFile: 'packages/helix/src/__tests__/pipeline.test.ts',
          description: 'pipeline passes',
          status: 'passing',
          coversFindings: ['finding-1'],
          isNew: true,
        },
        {
          testFile: 'packages/helix/src/__tests__/parser.test.ts',
          description: 'parser still failing',
          status: 'failing',
          coversFindings: ['finding-2'],
          isNew: true,
        },
      ],
      regressionSuite: [],
      locked: false,
    };

    expect(canEngageTestLock(lock)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  isAutoExpandableWorkspaceDriftPath,
  isManifestDriftEligiblePath,
} from '../pipeline/engine/manifest-drift.js';
import type { Slice } from '../types.js';

describe('manifest-drift', () => {
  it('treats tiered vitest configs as manifest-drift eligible', () => {
    expect(isManifestDriftEligiblePath('apps/runtime/vitest.e2e.config.ts')).toBe(true);
    expect(isManifestDriftEligiblePath('apps/runtime/vitest.hotspots.config.ts')).toBe(true);
    expect(isManifestDriftEligiblePath('apps/runtime/vitest.slow.config.ts')).toBe(true);
    expect(isManifestDriftEligiblePath('apps/nlu-sidecar/requirements.txt')).toBe(true);
    expect(isManifestDriftEligiblePath('apps/runtime/README.md')).toBe(false);
  });

  it('auto-expands tiered vitest configs for matching package-local slices', () => {
    expect(
      isAutoExpandableWorkspaceDriftPath(
        'apps/runtime/vitest.e2e.config.ts',
        ['apps/runtime'],
        createRuntimeSlice(),
      ),
    ).toBe(true);
  });

  it('auto-expands python dependency manifests for matching package-local slices', () => {
    expect(
      isAutoExpandableWorkspaceDriftPath(
        'apps/nlu-sidecar/requirements.txt',
        ['apps/runtime', 'apps/nlu-sidecar'],
        createSidecarSlice(),
      ),
    ).toBe(true);
  });
});

function createRuntimeSlice(): Slice {
  return {
    index: 0,
    title: 'Runtime slice',
    description: 'Runtime gather interrupt test slice',
    status: 'planned',
    findings: [],
    dependencies: [],
    manifest: {
      entryConditions: [],
      fileContracts: [
        {
          path: 'apps/runtime/src/__tests__/helpers/runtime-api-harness.ts',
          action: 'modify',
          reason: 'Expose test seam',
        },
      ],
      exportContracts: [],
    },
    testLock: {
      requiredTests: [],
      regressionSuite: [],
      locked: false,
    },
    impactAnalysis: {
      directFiles: ['apps/runtime/src/__tests__/helpers/runtime-api-harness.ts'],
      dependentFiles: [],
      affectedTests: [
        'apps/runtime/src/__tests__/e2e/gather-interrupt-semantic-routing.e2e.test.ts',
      ],
      riskLevel: 'medium',
      notes: 'Runtime package-local drift',
    },
    legacyPaths: [],
    exitCriteria: [],
  };
}

function createSidecarSlice(): Slice {
  return {
    index: 0,
    title: 'Sidecar slice',
    description: 'NLU sidecar contract hardening',
    status: 'planned',
    findings: [],
    dependencies: [],
    manifest: {
      entryConditions: [],
      fileContracts: [
        {
          path: 'apps/nlu-sidecar/app.py',
          action: 'modify',
          reason: 'Harden sidecar request contract',
        },
      ],
      exportContracts: [],
    },
    testLock: {
      requiredTests: [],
      regressionSuite: [],
      locked: false,
    },
    impactAnalysis: {
      directFiles: ['apps/nlu-sidecar/app.py'],
      dependentFiles: [],
      affectedTests: ['apps/nlu-sidecar/tests/test_app.py'],
      riskLevel: 'medium',
      notes: 'NLU sidecar package-local drift',
    },
    legacyPaths: [],
    exitCriteria: [],
  };
}

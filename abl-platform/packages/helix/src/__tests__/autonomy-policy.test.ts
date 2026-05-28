import { describe, expect, it } from 'vitest';

import {
  assessSliceAutonomy,
  formatDeferredBulkReviewQueue,
  markSliceQueuedForBulkReview,
} from '../pipeline/autonomy-policy.js';
import type { Session, Slice } from '../types.js';

describe('autonomy-policy', () => {
  it('escalates security-sensitive slices above the auto-commit threshold', () => {
    const session = createSession();
    const slice = createSlice({
      manifest: {
        entryConditions: [],
        fileContracts: [
          {
            path: 'apps/runtime/src/auth/unified-auth.ts',
            action: 'modify',
            reason: 'Auth seam change',
          },
        ],
        exportContracts: [],
      },
      impactAnalysis: {
        directFiles: ['apps/runtime/src/auth/unified-auth.ts'],
        dependentFiles: ['apps/runtime/src/routes/projects.ts'],
        affectedTests: ['apps/runtime/src/__tests__/auth.e2e.test.ts'],
        riskLevel: 'low',
        notes: 'Auth middleware path',
      },
      findings: ['finding-auth'],
    });
    session.slices = [slice];
    session.totalSlices = 1;
    session.findings = [
      {
        id: 'finding-auth',
        category: 'security',
        severity: 'high',
        status: 'open',
        title: 'Missing auth hardening',
        description: 'Security-sensitive auth seam',
        files: [{ path: 'apps/runtime/src/auth/unified-auth.ts' }],
        discoveredBy: 'Deep Scan',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ];

    const autonomy = assessSliceAutonomy(session, slice, {
      mode: 'thresholded',
      autoCommitMaxRisk: 'medium',
    });

    expect(autonomy.riskLevel).toBe('high');
    expect(autonomy.disposition).toBe('manual-checkpoint');
    expect(autonomy.reasons.join('\n')).toContain('sensitive finding categories');
    expect(autonomy.reasons.join('\n')).toContain('Touches sensitive files or seams');
  });

  it('keeps low-risk slices manual when confidence evidence is weak', () => {
    const session = createSession();
    const slice = createSlice({
      manifest: {
        entryConditions: [],
        fileContracts: [
          {
            path: 'packages/helix/src/parser.ts',
            action: 'modify',
            reason: 'Parser cleanup',
          },
        ],
        exportContracts: [],
      },
      impactAnalysis: {
        directFiles: ['packages/helix/src/parser.ts'],
        dependentFiles: [],
        affectedTests: [],
        riskLevel: 'low',
        notes: 'Small parser seam cleanup, but no real evidence yet.',
      },
      findings: ['finding-parser'],
    });
    session.slices = [slice];
    session.totalSlices = 1;
    session.findings = [
      {
        id: 'finding-parser',
        category: 'bug',
        severity: 'medium',
        status: 'open',
        title: 'Parser seam needs stabilization',
        description: 'Parser cleanup remains bounded and should be auto-committable.',
        files: [{ path: 'packages/helix/src/parser.ts' }],
        discoveredBy: 'Deep Scan',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ];

    const autonomy = assessSliceAutonomy(session, slice, {
      mode: 'thresholded',
      autoCommitMaxRisk: 'low',
    });

    expect(autonomy.riskLevel).toBe('low');
    expect(autonomy.confidenceLevel).toBe('low');
    expect(autonomy.disposition).toBe('manual-checkpoint');
    expect(autonomy.confidenceReasons.join('\n')).toContain('No inherited regression suite');
    expect(autonomy.confidenceReasons.join('\n')).toContain(
      'No E2E evidence was detected, but the seam remains locally bounded',
    );
  });

  it('queues medium-risk slices for deferred bulk review when regression and e2e evidence is strong', () => {
    const session = createSession();
    const slice = createSlice({
      manifest: {
        entryConditions: [],
        fileContracts: [
          {
            path: 'packages/helix/src/parser.ts',
            action: 'modify',
            reason: 'Parser cleanup',
          },
          {
            path: 'packages/helix/src/parser-consumer.ts',
            action: 'modify',
            reason: 'Consumer wiring update',
          },
        ],
        exportContracts: [
          {
            sourceFile: 'packages/helix/src/parser.ts',
            exportName: 'parseExpression',
            consumers: ['packages/helix/src/parser-consumer.ts'],
            isNew: false,
          },
        ],
      },
      testLock: {
        requiredTests: [
          {
            testFile: 'packages/helix/src/__tests__/parser.e2e.test.ts',
            description: 'E2E parser seam regression',
            status: 'passing',
            coversFindings: ['finding-parser'],
            isNew: false,
          },
        ],
        regressionSuite: ['packages/helix/src/parser.regression.test.ts'],
        locked: true,
        lockedAt: TIMESTAMP,
      },
      impactAnalysis: {
        directFiles: ['packages/helix/src/parser.ts', 'packages/helix/src/parser-consumer.ts'],
        dependentFiles: ['packages/helix/src/runtime.ts'],
        affectedTests: [
          'packages/helix/src/parser.regression.test.ts',
          'packages/helix/src/__tests__/parser.e2e.test.ts',
        ],
        riskLevel: 'medium',
        notes: 'Bounded parser seam cleanup.',
      },
      findings: ['finding-parser'],
      status: 'committed',
      commit: {
        sha: 'abcdef1234567890',
        message: '[ABLP-201] fix(helix): Stabilize parser seam',
        jiraKey: 'ABLP-201',
        sliceIndex: 0,
        files: ['packages/helix/src/parser.ts'],
        timestamp: TIMESTAMP,
      },
    });
    session.slices = [slice];
    session.totalSlices = 1;
    session.findings = [
      {
        id: 'finding-parser',
        category: 'bug',
        severity: 'medium',
        status: 'open',
        title: 'Parser seam needs stabilization',
        description: 'Parser cleanup remains bounded and should be auto-committable.',
        files: [{ path: 'packages/helix/src/parser.ts' }],
        discoveredBy: 'Deep Scan',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ];

    slice.autonomy = assessSliceAutonomy(session, slice, {
      mode: 'thresholded',
      autoCommitMaxRisk: 'medium',
    });
    slice.autonomy = markSliceQueuedForBulkReview(slice);

    const rendered = formatDeferredBulkReviewQueue(session);

    expect(slice.autonomy).toMatchObject({
      disposition: 'deferred-bulk-review',
      confidenceLevel: 'high',
      bulkReviewStatus: 'queued',
    });
    expect(rendered).toContain('Slice 1: Parser seam slice');
    expect(rendered).toContain('Confidence: high');
    expect(rendered).toContain('abcdef1 [ABLP-201] fix(helix): Stabilize parser seam');
    expect(rendered).toContain('Confidence evidence');
  });

  it('uses trust profiles to boost confidence for mature modules only when required evidence is present', () => {
    const session = createSession();
    const slice = createSlice({
      manifest: {
        entryConditions: [],
        fileContracts: [
          {
            path: 'apps/studio/src/features/evals/runtime-panel.ts',
            action: 'modify',
            reason: 'Mature eval module update',
          },
        ],
        exportContracts: [],
      },
      testLock: {
        requiredTests: [
          {
            testFile: 'apps/studio/src/features/evals/runtime-panel.e2e.test.ts',
            description: 'E2E for mature eval module',
            status: 'passing',
            coversFindings: ['finding-evals'],
            isNew: false,
          },
        ],
        regressionSuite: ['apps/studio/src/features/evals/runtime-panel.regression.test.ts'],
        locked: true,
        lockedAt: TIMESTAMP,
      },
      impactAnalysis: {
        directFiles: ['apps/studio/src/features/evals/runtime-panel.ts'],
        dependentFiles: ['apps/studio/src/features/evals/runtime-shell.ts'],
        affectedTests: [
          'apps/studio/src/features/evals/runtime-panel.regression.test.ts',
          'apps/studio/src/features/evals/runtime-panel.e2e.test.ts',
        ],
        riskLevel: 'medium',
        notes: 'Mature eval module with strong test history.',
      },
      findings: ['finding-evals'],
    });
    session.slices = [slice];
    session.totalSlices = 1;
    session.findings = [
      {
        id: 'finding-evals',
        category: 'bug',
        severity: 'medium',
        status: 'open',
        title: 'Eval runtime panel needs cleanup',
        description: 'Mature module with strong test coverage.',
        files: [{ path: 'apps/studio/src/features/evals/runtime-panel.ts' }],
        discoveredBy: 'Deep Scan',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ];

    const autonomy = assessSliceAutonomy(session, slice, {
      mode: 'thresholded',
      autoCommitMaxRisk: 'low',
      moduleTrustProfiles: [
        {
          name: 'Mature eval surfaces',
          pathPatterns: ['apps/studio/src/features/evals/**'],
          confidenceBoost: 2,
          maxAutoCommitRisk: 'medium',
          requiredSignals: ['regression-suite', 'e2e'],
          notes: 'This module has stable black-box coverage and mature ownership.',
        },
      ],
    });

    expect(autonomy.disposition).toBe('deferred-bulk-review');
    expect(autonomy.matchedTrustProfiles).toEqual(['Mature eval surfaces']);
    expect(autonomy.confidenceReasons.join('\n')).toContain(
      'Trust profile Mature eval surfaces adjusts confidence by +2',
    );
    expect(autonomy.confidenceReasons.join('\n')).toContain(
      'Trust profile Mature eval surfaces requirements are satisfied',
    );
  });

  it('keeps trust-profiled modules manual when the promised e2e evidence is missing', () => {
    const session = createSession();
    const slice = createSlice({
      manifest: {
        entryConditions: [],
        fileContracts: [
          {
            path: 'apps/studio/src/features/evals/runtime-panel.ts',
            action: 'modify',
            reason: 'Mature eval module update',
          },
        ],
        exportContracts: [],
      },
      testLock: {
        requiredTests: [
          {
            testFile: 'apps/studio/src/features/evals/runtime-panel.test.ts',
            description: 'Unit regression only',
            status: 'passing',
            coversFindings: ['finding-evals'],
            isNew: false,
          },
        ],
        regressionSuite: ['apps/studio/src/features/evals/runtime-panel.regression.test.ts'],
        locked: true,
        lockedAt: TIMESTAMP,
      },
      impactAnalysis: {
        directFiles: ['apps/studio/src/features/evals/runtime-panel.ts'],
        dependentFiles: ['apps/studio/src/features/evals/runtime-shell.ts'],
        affectedTests: ['apps/studio/src/features/evals/runtime-panel.regression.test.ts'],
        riskLevel: 'low',
        notes: 'Mature eval module, but the E2E evidence is currently missing.',
      },
      findings: ['finding-evals'],
    });
    session.slices = [slice];
    session.totalSlices = 1;
    session.findings = [
      {
        id: 'finding-evals',
        category: 'bug',
        severity: 'medium',
        status: 'open',
        title: 'Eval runtime panel needs cleanup',
        description: 'Mature module with incomplete evidence for auto-commit.',
        files: [{ path: 'apps/studio/src/features/evals/runtime-panel.ts' }],
        discoveredBy: 'Deep Scan',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ];

    const autonomy = assessSliceAutonomy(session, slice, {
      mode: 'thresholded',
      autoCommitMaxRisk: 'low',
      moduleTrustProfiles: [
        {
          name: 'Mature eval surfaces',
          pathPatterns: ['apps/studio/src/features/evals/**'],
          confidenceBoost: 2,
          maxAutoCommitRisk: 'medium',
          requiredSignals: ['regression-suite', 'e2e'],
          notes: 'This module has stable black-box coverage and mature ownership.',
        },
      ],
    });

    expect(autonomy.disposition).toBe('manual-checkpoint');
    expect(autonomy.confidenceReasons.join('\n')).toContain(
      'Trust profile Mature eval surfaces is missing required evidence: e2e',
    );
  });
});

const TIMESTAMP = '2026-04-01T00:00:00.000Z';

function createSession(): Session {
  return {
    id: 'session-autonomy',
    workItem: {
      id: 'work-autonomy',
      type: 'feature-audit',
      title: 'Autonomy policy',
      description: 'Test HELIX autonomy policy',
      scope: ['packages/helix/src'],
      targetBranch: 'current',
      createdAt: TIMESTAMP,
    },
    pipelineName: 'Holistic Feature Audit',
    pipelineVersion: 'Holistic Feature Audit@123456789abc',
    state: 'planning',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 0,
    slices: [],
    findings: [],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function createSlice(overrides: Partial<Slice> = {}): Slice {
  return {
    index: 0,
    title: 'Parser seam slice',
    description: 'Stabilize parser seam',
    status: 'pending',
    findings: [],
    dependencies: [],
    manifest: {
      entryConditions: [],
      fileContracts: [],
      exportContracts: [],
    },
    testLock: {
      requiredTests: [
        {
          testFile: 'packages/helix/src/parser.test.ts',
          description: 'Parser regression',
          status: 'pending',
          coversFindings: [],
          isNew: false,
        },
      ],
      regressionSuite: [],
      locked: false,
    },
    impactAnalysis: {
      directFiles: ['packages/helix/src/parser.ts'],
      dependentFiles: [],
      affectedTests: ['packages/helix/src/parser.test.ts'],
      riskLevel: 'low',
      notes: 'Bounded parser seam cleanup.',
    },
    legacyPaths: [],
    exitCriteria: [],
    ...overrides,
  };
}

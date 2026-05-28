import { describe, expect, it } from 'vitest';

import {
  canPromoteFailureAdvisoryStage,
  maybePromoteFailureAdvisoryAction,
} from '../pipeline/engine/failure-advisory-actions.js';
import { buildFailureAdvisoryPromotionOutput } from '../pipeline/engine/failure-advisory-promotion.js';
import type {
  CommitRecord,
  FailureAdvisoryRecord,
  QualityGateCheckResult,
  Session,
  StageDefinition,
  StageResult,
} from '../types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    workItem: { type: 'feature-audit', title: 't', description: 'd', scope: [] },
    state: 'executing',
    pipelineSnapshot: { name: 'test', stages: [] },
    findings: [],
    decisions: [],
    slices: [],
    commits: [],
    stageHistory: [],
    journal: [],
    ...overrides,
  } as unknown as Session;
}

function makeStage(type: StageDefinition['type'], name = 'stage-1'): StageDefinition {
  return {
    name,
    type,
    description: '',
    model: { primary: { engine: 'claude-code' } },
  } as unknown as StageDefinition;
}

function makeCommit(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    sha: 'a'.repeat(40),
    message: '[ABLP-1] feat(x): commit',
    jiraKey: 'ABLP-1',
    sliceIndex: 0,
    files: ['src/foo.ts'],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeCheck(name: string, passed: boolean, isModelReview = false): QualityGateCheckResult {
  return {
    name,
    passed,
    durationMs: 1,
    output: '',
    modelReview: isModelReview
      ? {
          schemaId: 'analysis-report',
          approved: passed,
          findings: [],
          unresolvedDecisions: [],
          summary: '',
        }
      : undefined,
  };
}

function makeResult(
  checks: QualityGateCheckResult[],
  overrides: Partial<StageResult> = {},
): StageResult {
  return {
    stageName: 'stage-1',
    stageType: 'implementation',
    status: 'failed',
    output: '',
    findings: [],
    decisions: [],
    durationMs: 1,
    iterations: 1,
    model: 'sonnet',
    qualityGate: {
      name: 'gate',
      passed: false,
      feedback: '',
      checks,
      durationMs: 1,
    },
    ...overrides,
  };
}

describe('Slice 19: canPromoteFailureAdvisoryStage — non-replay post-proof', () => {
  it('promotes implementation when deterministic checks pass + commit landed + model-review failed', () => {
    const session = makeSession({ commits: [makeCommit()] });
    const stage = makeStage('implementation');
    const result = makeResult([
      makeCheck('TypeScript compiles', true),
      makeCheck('Tests pass', true),
      makeCheck('Code formatted', true),
      makeCheck('Architecture review', false, true),
    ]);

    expect(canPromoteFailureAdvisoryStage(session, stage, result, '', '', '')).toBe(true);
  });

  it('promotes regression with same evidence pattern', () => {
    const session = makeSession({ commits: [makeCommit()] });
    const stage = makeStage('regression');
    const result = makeResult([
      makeCheck('All tests pass', true),
      makeCheck('Production readiness', false, true),
    ]);

    expect(canPromoteFailureAdvisoryStage(session, stage, result, '', '', '')).toBe(true);
  });

  it('promotes doc-sync when deterministic surface passes + commits exist + stage timed out', () => {
    const session = makeSession({ commits: [makeCommit()] });
    const stage = makeStage('doc-sync');
    const result = makeResult([makeCheck('No mocks in E2E', true)], {
      error: 'doc-sync timed out',
      timeoutEvents: [{ type: 'stage', limitMs: 1000, elapsedMs: 1100 } as never],
    });

    expect(canPromoteFailureAdvisoryStage(session, stage, result, '', '', '')).toBe(true);
  });

  it('refuses promotion when no commits have landed yet', () => {
    const session = makeSession({ commits: [] });
    const stage = makeStage('implementation');
    const result = makeResult([
      makeCheck('Tests pass', true),
      makeCheck('Architecture review', false, true),
    ]);

    expect(canPromoteFailureAdvisoryStage(session, stage, result, '', '', '')).toBe(false);
  });

  it('refuses promotion when a deterministic check failed', () => {
    const session = makeSession({ commits: [makeCommit()] });
    const stage = makeStage('implementation');
    const result = makeResult([
      makeCheck('Tests pass', false),
      makeCheck('Architecture review', false, true),
    ]);

    expect(canPromoteFailureAdvisoryStage(session, stage, result, '', '', '')).toBe(false);
  });

  it('refuses promotion when no model-review failed AND no error/timeout (genuinely passing already)', () => {
    const session = makeSession({ commits: [makeCommit()] });
    const stage = makeStage('implementation');
    const result = makeResult([makeCheck('Tests pass', true)]);

    expect(canPromoteFailureAdvisoryStage(session, stage, result, '', '', '')).toBe(false);
  });

  it('does not affect stages outside implementation/regression/doc-sync', () => {
    const session = makeSession({ commits: [makeCommit()] });
    const stage = makeStage('plan-generation');
    const result = makeResult([
      makeCheck('Tests pass', true),
      makeCheck('Plan review', false, true),
    ]);

    expect(canPromoteFailureAdvisoryStage(session, stage, result, '', '', '')).toBe(false);
  });
});

describe('Slice 19: maybePromoteFailureAdvisoryAction upgrades retry-stage to promote-stage', () => {
  it('upgrades when canPromote returns true on a non-replay implementation stage', () => {
    const session = makeSession({ commits: [makeCommit()] });
    const stage = makeStage('implementation');
    const result = makeResult([
      makeCheck('Tests pass', true),
      makeCheck('Wiring review', false, true),
    ]);

    const upgraded = maybePromoteFailureAdvisoryAction(
      session,
      stage,
      result,
      'retry-stage',
      'tests green and committed',
      '',
      '',
    );
    expect(upgraded).toBe('promote-stage');
  });

  it('does not upgrade synthesize-stage or switch-model actions', () => {
    const session = makeSession({ commits: [makeCommit()] });
    const stage = makeStage('implementation');
    const result = makeResult([
      makeCheck('Tests pass', true),
      makeCheck('Wiring review', false, true),
    ]);

    expect(
      maybePromoteFailureAdvisoryAction(session, stage, result, 'synthesize-stage', '', '', ''),
    ).toBe('synthesize-stage');
    expect(
      maybePromoteFailureAdvisoryAction(session, stage, result, 'switch-model', '', '', ''),
    ).toBe('switch-model');
  });
});

describe('Slice 19: buildFailureAdvisoryPromotionOutput non-replay path', () => {
  it('emits a human-readable promotion summary with deterministic checks + commits', async () => {
    const session = makeSession({
      commits: [
        makeCommit({ sha: 'a'.repeat(40), message: '[ABLP-1] feat(x): first commit' }),
        makeCommit({ sha: 'b'.repeat(40), message: '[ABLP-1] feat(x): second commit' }),
      ],
    });
    const stage = makeStage('implementation');
    const result = makeResult([
      makeCheck('Tests pass', true),
      makeCheck('TypeScript compiles', true),
      makeCheck('Architecture review', false, true),
    ]);
    const advisory: FailureAdvisoryRecord = {
      id: 'adv-1',
      stageName: stage.name,
      stageType: stage.type,
      failureCategory: 'quality-gate',
      failureSignature: 'arch-review-oscillation',
      retryCount: 0,
      sourceError: '',
      generatedAt: new Date().toISOString(),
      summary: 'Architecture review oscillated between approve and block.',
      suspectedCause: 'flaky model review',
      recommendedAction: 'promote-stage',
      promptGuidance: null,
      operatorActions: [],
      evidenceDigest: [],
    };

    const output = await buildFailureAdvisoryPromotionOutput(
      '/tmp/non-existent-workdir',
      session,
      stage,
      advisory,
      result,
    );

    expect(output).toContain('Promoted');
    expect(output).toContain('Deterministic checks (2) all passed');
    expect(output).toContain('Tests pass');
    expect(output).toContain('TypeScript compiles');
    expect(output).toContain('Failing model-review checks (1) treated as advisory');
    expect(output).toContain('Architecture review');
    expect(output).toContain(`${'a'.slice(0, 7)} [ABLP-1] feat(x): first commit`);
    expect(output).toContain(`${'b'.slice(0, 7)} [ABLP-1] feat(x): second commit`);
  });

  it('returns null when called on a non-implementation/regression/doc-sync stage', async () => {
    const session = makeSession({ commits: [makeCommit()] });
    const stage = makeStage('plan-generation');
    const result = makeResult([makeCheck('Tests pass', true)]);
    const advisory = {
      recommendedAction: 'promote-stage',
      summary: 's',
      suspectedCause: '',
      sourceError: '',
    } as FailureAdvisoryRecord;

    const output = await buildFailureAdvisoryPromotionOutput(
      '/tmp/non-existent-workdir',
      session,
      stage,
      advisory,
      result,
    );
    expect(output).toBeNull();
  });
});

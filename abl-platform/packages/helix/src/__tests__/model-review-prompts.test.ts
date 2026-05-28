import { describe, expect, it } from 'vitest';

import type { Session, StageDefinition, StageResult } from '../types.js';
import {
  buildFailureAdvisoryPrompt,
  PRODUCTION_READINESS_REVIEW_GUIDANCE,
} from '../pipeline/model-review-prompts.js';

describe('buildFailureAdvisoryPrompt', () => {
  it('includes execution signals when a stalled stage already inspected the workspace', () => {
    const session = {
      workItem: {
        id: 'wi-1',
        type: 'feature-audit',
        title: 'Replay project member service extraction',
        description: 'Replay a historical RBAC service extraction.',
        scope: ['apps/studio', 'packages/database'],
        targetBranch: 'develop',
        createdAt: '2026-04-15T00:00:00.000Z',
      },
      findings: [],
      commits: [],
    } as Session;

    const stage = {
      name: 'Deep Scan',
      type: 'deep-scan',
      description: 'Inspect the historical project-member seam.',
    } as StageDefinition;

    const result = {
      stageName: 'Deep Scan',
      stageType: 'deep-scan',
      status: 'failed',
      output: '',
      findings: [],
      decisions: [],
      durationMs: 135_000,
      iterations: 1,
      model: 'gpt-5.5',
      error:
        "Codex stalled after 83s of inactivity (135s total elapsed, 0 turns) Observed execution signals: progress=12, output=0, toolUse=12, shellCommands=12. Recent activity: Bash: sed -n '1,260p' apps/studio/src/repos/project-repo.ts",
      executionSummary: {
        progressEvents: 12,
        outputEvents: 0,
        toolUseEvents: 12,
        errorEvents: 0,
        shellCommandEvents: 12,
        recentMessages: [
          "Bash: sed -n '1,260p' apps/studio/src/repos/project-repo.ts",
          'Command exit 0: findProjectMembers(...)',
        ],
      },
    } as StageResult;

    const prompt = buildFailureAdvisoryPrompt({
      session,
      stage,
      result,
      failureCategory: 'model-error',
      failureSignature: 'Deep Scan:model-error:stall',
      priorRetryCount: 0,
      currentEfficiencyBudget: {
        targetTurns: 18,
        explorationTurns: 8,
      },
    });

    expect(prompt).toContain('## Observed Execution Signals');
    expect(prompt).toContain('Shell commands: 12');
    expect(prompt).toContain('Recent activity:');
    expect(prompt).toContain('do not classify the failure as a startup hang');
  });
});

describe('PRODUCTION_READINESS_REVIEW_GUIDANCE', () => {
  it('anchors reviewers to carried proof and checked-in python environments', () => {
    expect(PRODUCTION_READINESS_REVIEW_GUIDANCE).toContain(
      'Start from the carried regression proof and required tests already declared for the stage.',
    );
    expect(PRODUCTION_READINESS_REVIEW_GUIDANCE).toContain(
      'Prefer focused package builds and explicit Vitest configs over repo-root `pnpm test -- --runInBand` style retries.',
    );
    expect(PRODUCTION_READINESS_REVIEW_GUIDANCE).toContain('invoke tests through that interpreter');
  });
});

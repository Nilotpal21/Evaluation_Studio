import { describe, expect, it } from 'vitest';

import type { FailureAdvisoryRecord, Session, StageDefinition } from '../types.js';
import {
  applyFailureAdvisoryRetryPromptOverride,
  applyFailureAdvisorySynthesisPromptOverride,
} from '../pipeline/engine/failure-advisory-prompt-overrides.js';

function createAdvisory(): FailureAdvisoryRecord {
  return {
    id: 'adv-1234',
    stageName: 'Regression',
    stageType: 'regression',
    failureCategory: 'timeout',
    failureSignature: 'Regression:error:timed-out',
    retryCount: 0,
    sourceError: 'Regression timed out',
    generatedAt: '2026-04-23T06:00:00.000Z',
    summary: 'Regression timed out after gathering enough seam evidence.',
    suspectedCause: 'The prior retry stalled after getting to the right seam.',
    recommendedAction: 'pause-and-resume',
    evidenceDigest: ['Required regression files were already identified.'],
    promptGuidance: 'Resume from the retained regression work item instead of cold-starting.',
    operatorActions: ['Resume the stage with the retained regression work item.'],
  };
}

function createSession(): Session {
  return {
    id: 'session-1234',
    pipelineName: 'Holistic Feature Audit',
    pipelineVersion: 'test',
    workItem: {
      title: 'Gather Interrupt Semantic Routing',
      description: 'Recover the regression stage',
      jiraKey: 'ABLP-496',
      specs: {},
      scope: ['apps/runtime'],
      branch: 'develop',
    },
    state: 'paused',
    stageHistory: [],
    findings: [],
    decisions: [],
    commits: [],
    journal: [],
    costByProvider: {},
    promptContext: {
      instructionDocs: [],
      featureSpecExcerpts: [],
      codeMapEntries: [],
      nativeToolAvailability: {
        helixFindSymbol: false,
        helixFindReferences: false,
        helixGetRouteInfo: false,
        helixGetSchemaInfo: false,
        helixGetImpactedTests: false,
      },
      repoIndexedAt: null,
    },
    pipelineSnapshot: {
      name: 'Holistic Feature Audit',
      description: 'test snapshot',
      applicableTo: [],
      stages: [],
    },
    verificationBootstrap: {},
    heartbeat: { intervalMs: 1000, adaptive: true },
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 0,
    slices: [],
    checkpointApprovals: {},
    failureAdvisories: [],
    harnessDefects: [],
    oracleCheckpoints: [],
    workspaceBaseline: {
      gitStatusPorcelain: '',
      trackedDirtyPaths: [],
      untrackedPaths: [],
      workDir: '/Users/prasannaarikala/projects/agent-platform',
      capturedAt: '2026-04-23T06:00:00.000Z',
    },
    workspaceContext: {
      mode: 'in-place',
      rootDir: '/Users/prasannaarikala/projects/agent-platform',
      targetDir: '/Users/prasannaarikala/projects/agent-platform',
      branchRef: 'develop',
      baselineCaptured: true,
    },
    startedAt: '2026-04-23T06:00:00.000Z',
    updatedAt: '2026-04-23T06:00:00.000Z',
  } as Session;
}

function createRegressionStage(): StageDefinition {
  return {
    name: 'Regression',
    type: 'regression',
    description: 'Run the full regression suite across all affected packages',
    model: {
      primary: {
        engine: 'codex-cli',
        model: 'gpt-5.4',
      },
    },
    qualityGate: {
      name: 'Regression Suite',
      checks: [],
    },
    timeoutMs: 900000,
  };
}

describe('failure advisory prompt overrides', () => {
  it('prepends the default regression prompt when no stage-specific prompt exists', () => {
    const stage = createRegressionStage();

    applyFailureAdvisoryRetryPromptOverride(stage, createAdvisory(), createSession());

    expect(stage.prompt).toContain('## FAILURE ADVISORY RECOVERY MODE');
    expect(stage.prompt).toContain('Run the full regression suite for the affected packages.');
    expect(stage.prompt).toContain('1. Start from the carried regression suite');
  });

  it('prepends the default prompt in synthesis mode when no stage-specific prompt exists', () => {
    const stage = createRegressionStage();

    applyFailureAdvisorySynthesisPromptOverride(stage, createAdvisory(), createSession());

    expect(stage.prompt).toContain('## TOP PRIORITY RECOVERY MODE');
    expect(stage.prompt).toContain('Run the full regression suite for the affected packages.');
    expect(stage.prompt).toContain('## Your Task');
  });
});

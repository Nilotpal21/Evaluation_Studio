import { describe, expect, it } from 'vitest';

import { DEFAULT_STAGE_MODEL_POLICY } from '../runtime-config.js';
import type { ExecutorEfficiencyBudget, Session, StageDefinition } from '../types.js';
import {
  buildStageExecutionEnvelope,
  mergeExecutorEfficiencyBudget,
  resolveStageExecutionAssignment,
} from '../pipeline/execution-envelope.js';

function makeStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    name: 'Deep Scan',
    type: 'deep-scan',
    description: 'Scan deeply',
    role: undefined,
    model: {
      primary: {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 10,
      },
    },
    tools: ['Read', 'Bash'],
    canLoop: true,
    maxLoopIterations: 2,
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<Pick<Session, 'pipelineName' | 'replayContext'>> = {},
): Pick<Session, 'pipelineName' | 'replayContext'> {
  return {
    pipelineName: 'Holistic Feature Audit',
    replayContext: undefined,
    ...overrides,
  };
}

describe('execution-envelope', () => {
  it('uses role routing when stage-specific routing is absent', () => {
    const stage = makeStage({
      type: 'custom',
      role: 'review',
    });

    const assignment = resolveStageExecutionAssignment(stage, DEFAULT_STAGE_MODEL_POLICY, false);

    expect(assignment.primary.engine).toBe('claude-code');
  });

  it('lets an explicit synthesize role override the deep-scan stage policy', () => {
    const stage = makeStage({
      role: 'synthesize',
    });

    const envelope = buildStageExecutionEnvelope({
      stage,
      session: makeSession({
        replayContext: {
          changedFiles: new Array(8).fill('apps/studio/src/foo.ts'),
          tags: ['service-extraction'],
        },
      }),
      prompt: 'scan',
      policy: DEFAULT_STAGE_MODEL_POLICY,
      allowFallbacks: true,
      isBroadReplayTask: true,
    });

    expect(envelope.assignment.primary.engine).toBe('claude-api');
    expect(envelope.assignment.primary.model).toBe('claude-sonnet-4-6');
    expect(envelope.assignment.primary.maxTurns).toBe(10);
    expect(envelope.assignment.fallback).toBeUndefined();
  });

  it('prefers claude-api for standard deep-scan stages', () => {
    const stage = makeStage();

    const envelope = buildStageExecutionEnvelope({
      stage,
      session: makeSession(),
      prompt: 'scan',
      policy: DEFAULT_STAGE_MODEL_POLICY,
      allowFallbacks: false,
    });

    expect(envelope.assignment.primary.engine).toBe('claude-api');
    expect(envelope.assignment.primary.model).toBe('claude-sonnet-4-6');
    expect(envelope.tools).toEqual(['Read', 'Bash']);
  });

  it('prefers codex for regression stages even when the stage template carries a claude model', () => {
    const stage = makeStage({
      name: 'Regression',
      type: 'regression',
      description: 'Run regression proof',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'sonnet',
          maxTurns: 20,
        },
      },
    });

    const envelope = buildStageExecutionEnvelope({
      stage,
      session: makeSession(),
      prompt: 'regress',
      policy: DEFAULT_STAGE_MODEL_POLICY,
      allowFallbacks: false,
    });

    expect(envelope.assignment.primary.engine).toBe('codex-cli');
    expect(envelope.assignment.primary.model).toBe('gpt-5.4');
  });

  it('prefers claude-api for broad replay plan synthesis when tools are disabled', () => {
    const stage = makeStage({
      type: 'plan-generation',
      name: 'Plan Generation',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'claude-opus-4-7',
          maxTurns: 12,
        },
      },
      tools: ['Read', 'Grep', 'Glob'],
    });

    const envelope = buildStageExecutionEnvelope({
      stage,
      session: makeSession({
        replayContext: {
          changedFiles: new Array(8).fill('apps/studio/src/foo.ts'),
          tags: ['service-extraction'],
        },
      }),
      prompt: 'plan',
      policy: DEFAULT_STAGE_MODEL_POLICY,
      allowFallbacks: false,
      isBroadReplayTask: true,
    });

    expect(envelope.assignment.primary.engine).toBe('claude-api');
    expect(envelope.assignment.primary.model).toBe('claude-sonnet-4-6');
    expect(envelope.tools).toEqual([]);
  });

  it('prefers claude for broad replay deep scans', () => {
    const stage = makeStage();
    const envelope = buildStageExecutionEnvelope({
      stage,
      session: makeSession({
        replayContext: {
          changedFiles: new Array(8).fill('apps/studio/src/foo.ts'),
          tags: ['service-extraction'],
        },
      }),
      prompt: 'scan',
      policy: DEFAULT_STAGE_MODEL_POLICY,
      allowFallbacks: false,
      isBroadReplayTask: true,
    });

    expect(envelope.assignment.primary.engine).toBe('claude-code');
    expect(envelope.assignment.primary.model).toBe('claude-sonnet-4-6');
  });

  it('disables plan-generation tools for broad replays', () => {
    const stage = makeStage({
      type: 'plan-generation',
      name: 'Plan',
      tools: ['Read', 'Grep', 'Bash'],
      model: {
        primary: {
          engine: 'claude-code',
          model: 'claude-opus-4-7',
        },
      },
    });

    const envelope = buildStageExecutionEnvelope({
      stage,
      session: makeSession(),
      prompt: 'plan',
      policy: DEFAULT_STAGE_MODEL_POLICY,
      allowFallbacks: false,
      isBroadReplayTask: true,
    });

    expect(envelope.tools).toEqual([]);
  });

  it('applies efficiency budgets and stall thresholds to the assignment', () => {
    const stage = makeStage();
    const efficiencyBudget: ExecutorEfficiencyBudget = {
      targetTurns: 12,
      explorationTurns: 4,
      hardTurnCap: 14,
      shellWarnFloor: 4,
      shellAbortFloor: 5,
      summary: 'test',
    };

    const envelope = buildStageExecutionEnvelope({
      stage,
      session: makeSession(),
      prompt: 'scan',
      policy: DEFAULT_STAGE_MODEL_POLICY,
      allowFallbacks: false,
      efficiencyBudget,
      stallThresholdMs: 45_000,
    });

    expect(envelope.assignment.primary.efficiencyBudget).toMatchObject({
      targetTurns: 12,
      explorationTurns: 4,
      hardTurnCap: 14,
      shellWarnFloor: 4,
      shellAbortFloor: 5,
    });
    expect(envelope.assignment.primary.stallThresholdMs).toBe(45_000);
  });

  it('merges efficiency budgets conservatively', () => {
    const merged = mergeExecutorEfficiencyBudget(
      {
        targetTurns: 10,
        explorationTurns: 3,
        hardTurnCap: 12,
        forbiddenShellPatterns: ['^ls'],
      },
      {
        targetTurns: 8,
        explorationTurns: 5,
        hardTurnCap: 11,
        forbiddenShellPatterns: ['^find'],
      },
    );

    expect(merged.targetTurns).toBe(10);
    expect(merged.explorationTurns).toBe(5);
    expect(merged.hardTurnCap).toBe(12);
    expect(merged.forbiddenShellPatterns).toEqual(['^ls', '^find']);
  });
});

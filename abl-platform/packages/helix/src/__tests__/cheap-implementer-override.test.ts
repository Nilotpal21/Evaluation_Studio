import { describe, expect, it } from 'vitest';

import { applyCheapImplementerOverride } from '../pipeline/cheap-implementer-override.js';
import type { PipelineTemplate } from '../types.js';

function makePipeline(): PipelineTemplate {
  return {
    name: 'test',
    description: 'test',
    applicableTo: ['feature-audit'],
    stages: [
      {
        name: 'Bootstrap',
        type: 'bootstrap',
        description: 'bootstrap',
        model: { primary: { engine: 'claude-code' } },
      },
      {
        name: 'Implementation',
        type: 'implementation',
        description: 'Implement slices',
        model: {
          primary: {
            engine: 'codex-cli',
            model: 'gpt-5.5',
            maxTurns: 50,
            maxBudgetUsd: 20,
          },
          layered: [{ engine: 'claude-code', model: 'opus', maxTurns: 40 }],
        },
      },
      {
        name: 'Regression',
        type: 'regression',
        description: 'regression',
        model: { primary: { engine: 'claude-code', model: 'sonnet' } },
      },
    ],
  };
}

describe('applyCheapImplementerOverride', () => {
  it('swaps implementation primary to sonnet and demotes original primary to fallback', () => {
    const pipeline = makePipeline();
    const { applied } = applyCheapImplementerOverride(pipeline);

    expect(applied).toEqual([
      { stageName: 'Implementation', previousEngine: 'codex-cli', previousModel: 'gpt-5.5' },
    ]);

    const impl = pipeline.stages.find((s) => s.type === 'implementation');
    expect(impl?.model.primary).toEqual({
      engine: 'claude-code',
      model: 'claude-sonnet-4-6',
      maxTurns: 50,
      maxBudgetUsd: 8,
      permissionMode: 'bypassPermissions',
    });
    expect(impl?.model.fallback).toEqual({
      engine: 'codex-cli',
      model: 'gpt-5.5',
      maxTurns: 50,
      maxBudgetUsd: 20,
    });
  });

  it('preserves layered review specs (opus discriminator stays)', () => {
    const pipeline = makePipeline();
    applyCheapImplementerOverride(pipeline);
    const impl = pipeline.stages.find((s) => s.type === 'implementation');
    expect(impl?.model.layered).toEqual([{ engine: 'claude-code', model: 'opus', maxTurns: 40 }]);
  });

  it('does not touch non-implementation stages', () => {
    const pipeline = makePipeline();
    const before = JSON.stringify(pipeline.stages.filter((s) => s.type !== 'implementation'));
    applyCheapImplementerOverride(pipeline);
    const after = JSON.stringify(pipeline.stages.filter((s) => s.type !== 'implementation'));
    expect(after).toBe(before);
  });

  it('is a no-op when implementation primary is already a sonnet variant', () => {
    const pipeline = makePipeline();
    const impl = pipeline.stages.find((s) => s.type === 'implementation')!;
    impl.model.primary = { engine: 'claude-code', model: 'claude-sonnet-4-6', maxTurns: 30 };

    const { applied } = applyCheapImplementerOverride(pipeline);
    expect(applied).toEqual([]);
    expect(impl.model.primary).toEqual({
      engine: 'claude-code',
      model: 'claude-sonnet-4-6',
      maxTurns: 30,
    });
    expect(impl.model.fallback).toBeUndefined();
  });

  it('preserves an existing fallback when the original primary has nowhere else to go', () => {
    const pipeline = makePipeline();
    const impl = pipeline.stages.find((s) => s.type === 'implementation')!;
    impl.model.fallback = { engine: 'claude-code', model: 'opus', maxTurns: 50 };

    applyCheapImplementerOverride(pipeline);
    expect(impl.model.fallback).toEqual({ engine: 'claude-code', model: 'opus', maxTurns: 50 });
  });

  it('clamps the swapped primary maxBudgetUsd to a sane ceiling', () => {
    const pipeline = makePipeline();
    const impl = pipeline.stages.find((s) => s.type === 'implementation')!;
    impl.model.primary = { engine: 'codex-cli', model: 'gpt-5.5', maxBudgetUsd: 50 };

    applyCheapImplementerOverride(pipeline);
    expect(impl.model.primary?.maxBudgetUsd).toBe(8);
  });
});

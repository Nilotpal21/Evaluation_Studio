import { describe, expect, it } from 'vitest';

import {
  applyStageMaxTurnsOverrides,
  parseStageMaxTurnsFlag,
} from '../pipeline/stage-max-turns-override.js';
import type { PipelineTemplate } from '../types.js';

describe('parseStageMaxTurnsFlag', () => {
  it('returns empty result for undefined / "true" / empty', () => {
    expect(parseStageMaxTurnsFlag(undefined)).toEqual({ overrides: [], errors: [] });
    expect(parseStageMaxTurnsFlag('true')).toEqual({ overrides: [], errors: [] });
    expect(parseStageMaxTurnsFlag('')).toEqual({ overrides: [], errors: [] });
  });

  it('parses a single stageType=N entry', () => {
    expect(parseStageMaxTurnsFlag('regression=40')).toEqual({
      overrides: [{ stageType: 'regression', maxTurns: 40 }],
      errors: [],
    });
  });

  it('parses comma-separated entries with whitespace', () => {
    expect(parseStageMaxTurnsFlag(' regression=40 , implementation=200 ,doc-sync=30')).toEqual({
      overrides: [
        { stageType: 'regression', maxTurns: 40 },
        { stageType: 'implementation', maxTurns: 200 },
        { stageType: 'doc-sync', maxTurns: 30 },
      ],
      errors: [],
    });
  });

  it('rejects entries missing =', () => {
    const result = parseStageMaxTurnsFlag('regression40');
    expect(result.overrides).toEqual([]);
    expect(result.errors[0]).toMatch(/missing '='/);
  });

  it('rejects unknown stage types', () => {
    const result = parseStageMaxTurnsFlag('not-a-stage=40');
    expect(result.overrides).toEqual([]);
    expect(result.errors[0]).toMatch(/unknown stage type "not-a-stage"/);
  });

  it('rejects non-positive maxTurns values', () => {
    const result = parseStageMaxTurnsFlag('regression=0,implementation=-5,deep-scan=abc');
    expect(result.overrides).toEqual([]);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toMatch(/positive integer/);
  });

  it('keeps valid entries even when others are invalid', () => {
    const result = parseStageMaxTurnsFlag('regression=40,not-a-stage=10,implementation=100');
    expect(result.overrides).toEqual([
      { stageType: 'regression', maxTurns: 40 },
      { stageType: 'implementation', maxTurns: 100 },
    ]);
    expect(result.errors).toHaveLength(1);
  });
});

describe('applyStageMaxTurnsOverrides', () => {
  function makePipeline(): PipelineTemplate {
    return {
      name: 'test',
      description: 'test',
      applicableTo: ['feature-audit'],
      stages: [
        {
          name: 'Implementation',
          type: 'implementation',
          description: 'Implement slices',
          model: {
            primary: { engine: 'codex-cli', model: 'gpt-5.5', maxTurns: 50 },
            fallback: { engine: 'claude-code', model: 'opus', maxTurns: 50 },
            layered: [{ engine: 'claude-code', model: 'sonnet', maxTurns: 40 }],
          },
        },
        {
          name: 'Regression',
          type: 'regression',
          description: 'Run regression suite',
          model: {
            primary: { engine: 'claude-code', model: 'sonnet', maxTurns: 20 },
          },
        },
      ],
    };
  }

  it('no-op when no overrides', () => {
    const pipeline = makePipeline();
    const before = JSON.parse(JSON.stringify(pipeline));
    const { applied } = applyStageMaxTurnsOverrides(pipeline, []);
    expect(applied).toEqual([]);
    expect(pipeline).toEqual(before);
  });

  it('applies override to primary, fallback, and layered for matching stage type', () => {
    const pipeline = makePipeline();
    const { applied } = applyStageMaxTurnsOverrides(pipeline, [
      { stageType: 'implementation', maxTurns: 200 },
    ]);
    expect(applied).toEqual([
      { stageName: 'Implementation', stageType: 'implementation', maxTurns: 200 },
    ]);
    expect(pipeline.stages[0]?.model.primary.maxTurns).toBe(200);
    expect(pipeline.stages[0]?.model.fallback?.maxTurns).toBe(200);
    expect(pipeline.stages[0]?.model.layered?.[0]?.maxTurns).toBe(200);
    // Other stage untouched
    expect(pipeline.stages[1]?.model.primary.maxTurns).toBe(20);
  });

  it('applies multiple overrides at once', () => {
    const pipeline = makePipeline();
    const { applied } = applyStageMaxTurnsOverrides(pipeline, [
      { stageType: 'implementation', maxTurns: 200 },
      { stageType: 'regression', maxTurns: 40 },
    ]);
    expect(applied).toHaveLength(2);
    expect(pipeline.stages[0]?.model.primary.maxTurns).toBe(200);
    expect(pipeline.stages[1]?.model.primary.maxTurns).toBe(40);
  });

  it('reports zero applied when override targets a stage not in pipeline', () => {
    const pipeline = makePipeline();
    const { applied } = applyStageMaxTurnsOverrides(pipeline, [
      { stageType: 'doc-sync', maxTurns: 60 },
    ]);
    expect(applied).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { buildCanaryPlanPrompt, createCanaryPipeline } from '../pipeline/canary-pipeline.js';
import { holisticAuditPipeline } from '../pipeline/templates/holistic-audit.js';

describe('canary-pipeline', () => {
  it('builds a bounded pre-implementation pipeline with a constrained deep scan prompt', () => {
    const pipeline = createCanaryPipeline(
      holisticAuditPipeline,
      ['packages/helix/src/models', 'packages/helix/src/pipeline'],
      240_000,
    );

    expect(pipeline.name).toContain('Canary');
    expect(pipeline.stages.map((stage) => stage.name)).toEqual([
      'Deep Scan',
      'Oracle Analysis',
      'Findings Review',
      'Plan Generation',
      'Plan Approval',
      'Manifest Compilation',
    ]);

    const deepScan = pipeline.stages[0];
    expect(deepScan.timeoutMs).toBe(240_000);
    expect(deepScan.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(deepScan.prompt).toContain('bounded HELIX canary');
    expect(deepScan.prompt).toContain(
      'Do NOT run package-manager, build, test, formatter, or git commands.',
    );
    expect(deepScan.prompt).toContain(
      'If a scoped file is large, grep for the report keywords or failing contract first',
    );
    expect(deepScan.prompt).toContain('- packages/helix/src/models');
    expect(deepScan.model.primary.effort).toBe('medium');
    expect(deepScan.model.primary.maxTurns).toBeLessThanOrEqual(12);
    expect(deepScan.model.fallback?.effort).toBe('medium');
    expect(deepScan.model.fallback?.maxTurns).toBeLessThanOrEqual(18);
    expect(deepScan.model.fallback?.maxBudgetUsd).toBeLessThanOrEqual(12);
  });

  it('does not mutate the base pipeline and clamps downstream stage budgets', () => {
    const pipeline = createCanaryPipeline(holisticAuditPipeline, ['packages/helix/src'], 120_000);

    expect(holisticAuditPipeline.name).toBe('Holistic Feature Audit');
    expect(holisticAuditPipeline.stages.length).toBeGreaterThan(pipeline.stages.length);
    expect(
      holisticAuditPipeline.stages.find((stage) => stage.name === 'Deep Scan')?.tools,
    ).toContain('Bash');
    expect(holisticAuditPipeline.stages.map((stage) => stage.name)).toContain('Implementation');

    const oracleStage = pipeline.stages[1];
    const planStage = pipeline.stages[3];
    const manifestStage = pipeline.stages[5];

    expect(oracleStage.timeoutMs).toBe(120_000);
    expect(oracleStage.substages?.every((stage) => stage.timeoutMs === undefined)).toBe(true);
    expect(oracleStage.substages?.every((stage) => stage.model.primary.model === 'sonnet')).toBe(
      true,
    );
    expect(oracleStage.substages?.every((stage) => stage.model.primary.effort === 'medium')).toBe(
      true,
    );
    expect(oracleStage.substages?.every((stage) => (stage.model.primary.maxTurns ?? 0) <= 12)).toBe(
      true,
    );
    expect(
      oracleStage.substages?.every((stage) => (stage.model.primary.maxBudgetUsd ?? 0) <= 4),
    ).toBe(true);
    expect(oracleStage.substages?.every((stage) => stage.tools?.join(',') === 'Read,Grep')).toBe(
      true,
    );
    expect(
      oracleStage.substages?.every((stage) =>
        stage.prompt?.includes('bounded HELIX canary oracle'),
      ),
    ).toBe(true);
    expect(
      oracleStage.substages?.every((stage) =>
        stage.prompt?.includes(
          'If a finding looks directionally correct and you cannot disprove it quickly, confirm it and move on.',
        ),
      ),
    ).toBe(true);
    expect(planStage.timeoutMs).toBe(120_000);
    expect(planStage.prompt).toContain('bounded HELIX canary implementation plan');
    expect(planStage.prompt).toContain('Copy the exact HELIX finding IDs');
    expect(planStage.prompt).toContain(
      'Use the finding registry and scoped docs as authoritative.',
    );
    expect(planStage.qualityGate?.timeoutMs).toBeUndefined();
    const reviewCheck = planStage.qualityGate?.checks[0];
    expect(reviewCheck?.type).toBe('model-review');
    expect(reviewCheck?.prompt).toContain('bounded HELIX canary review');
    expect(reviewCheck?.tools).toEqual(['Read']);
    expect(reviewCheck?.model?.primary.model).toBe('sonnet');
    expect(reviewCheck?.model?.primary.effort).toBe('medium');
    expect((reviewCheck?.model?.primary.maxTurns ?? 0) <= 8).toBe(true);
    expect((reviewCheck?.model?.primary.maxBudgetUsd ?? 0) <= 4).toBe(true);
    expect(planStage.model.primary.effort).toBe('medium');
    expect(planStage.model.primary.maxTurns).toBeLessThanOrEqual(18);
    expect(planStage.model.primary.maxBudgetUsd).toBeLessThanOrEqual(8);
    expect(manifestStage.timeoutMs).toBe(120_000);
  });

  it('builds a bounded canary planning prompt that avoids re-auditing the repo', () => {
    const prompt = buildCanaryPlanPrompt([
      'apps/studio/src/components/settings/PIIProtectionTab.tsx',
    ]);

    expect(prompt).toContain('Do not re-audit the feature. This stage is planning only.');
    expect(prompt).toContain(
      'Stay inside the provided scope and directly referenced helpers. Do not fan out across the repository for exhaustive discovery.',
    );
    expect(prompt).toContain(
      'Use the finding registry and scoped docs as authoritative. Do not reread large files unless a finding description is still ambiguous.',
    );
    expect(prompt).toContain('- apps/studio/src/components/settings/PIIProtectionTab.tsx');
    expect(prompt).toContain('{{findings}}');
  });
});

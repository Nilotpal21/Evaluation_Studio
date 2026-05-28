import { describe, expect, it } from 'vitest';

import { selectPipeline } from '../pipeline/templates/index.js';
import type {
  HelixDoctorModuleReport,
  HelixDoctorReport,
  HelixDoctorRunResult,
  HelixReadinessContracts,
  HelixVerificationContract,
} from '../readiness/doctor.js';
import { buildRuntimeReadinessPolicy } from '../readiness/runtime-policy.js';
import type { HelixConfig, HelixMcpServerDefinition, HelixStageModelPolicy } from '../types.js';

describe('runtime readiness policy', () => {
  it('forces manual characterize-first mode and derives trust profiles from verification policies', () => {
    const policy = buildRuntimeReadinessPolicy(
      createBaseConfig({
        autoCommit: false,
        autoApprove: false,
      }),
      selectPipeline('feature-audit'),
      createDoctorResult({
        summary: {
          readinessLevel: 'L1',
          autonomyRecommendation: 'characterize-first',
        },
        modules: [
          createModuleReport({
            id: 'runtime',
            maxAutonomyLevel: 'L1',
            requiredRegressionSuites: ['runtime-fast'],
            requiredE2ESuites: ['runtime-e2e'],
            coverageSignal: 'good',
          }),
        ],
        verification: {
          version: 1,
          modulePolicies: [
            {
              id: 'runtime',
              criticality: 'critical',
              paths: ['apps/runtime/src'],
              maxAutonomyLevel: 'L1',
              requiredSuites: {
                regression: ['runtime-fast'],
                e2e: ['runtime-e2e'],
              },
            },
          ],
        },
      }),
    );

    expect(policy.effectiveConfig.autoCommit).toBe(false);
    expect(policy.effectiveConfig.autoApprove).toBe(false);
    expect(policy.effectiveConfig.autonomy?.mode).toBe('manual');
    expect(policy.startupDecision.answer).toContain('characterize-first');
    expect(policy.effectiveConfig.autonomy?.moduleTrustProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'verification:runtime',
          pathPatterns: ['apps/runtime/src'],
          requiredSignals: ['regression-suite', 'e2e'],
        }),
      ]),
    );
    expect(policy.effectivePipeline.stages.map((stage) => stage.name)).not.toContain(
      'Readiness Override Approval',
    );
  });

  it('injects an audit-only checkpoint before write-enabled bug-fix stages', () => {
    const policy = buildRuntimeReadinessPolicy(
      createBaseConfig({
        autoCommit: false,
        autoApprove: false,
      }),
      selectPipeline('bug-fix'),
      createDoctorResult({
        summary: {
          readinessLevel: 'L0',
          autonomyRecommendation: 'audit-only',
        },
      }),
    );

    expect(policy.effectiveConfig.autoCommit).toBe(false);
    expect(policy.effectiveConfig.autoApprove).toBe(false);
    expect(policy.effectiveConfig.autonomy?.mode).toBe('manual');
    expect(policy.effectivePipeline.stages[0]?.name).toBe('Verification Bootstrap');
    expect(policy.effectivePipeline.stages[1]?.name).toBe('Readiness Override Approval');
    expect(policy.effectivePipeline.stages[2]?.name).toBe('Reproduce');
    expect(policy.summaryLines.join('\n')).toContain('pause for explicit approval');
  });

  it('preserves explicit auto-approve and auto-commit requests under manual safety rails', () => {
    const policy = buildRuntimeReadinessPolicy(
      createBaseConfig({
        autoCommit: true,
        autoApprove: true,
      }),
      selectPipeline('feature-audit'),
      createDoctorResult({
        summary: {
          readinessLevel: 'L1',
          autonomyRecommendation: 'characterize-first',
        },
      }),
    );

    expect(policy.effectiveConfig.autoCommit).toBe(true);
    expect(policy.effectiveConfig.autoApprove).toBe(true);
    expect(policy.effectiveConfig.autonomy?.mode).toBe('manual');
    expect(policy.summaryLines.join('\n')).toMatch(
      /requested auto-commit and auto-approve remain enabled/i,
    );
    expect(policy.startupDecision.answer).toContain(
      'requested auto-commit and auto-approve remain enabled',
    );
  });

  it('preserves requested thresholded autonomy for high-confidence repos', () => {
    const policy = buildRuntimeReadinessPolicy(
      createBaseConfig({
        autoCommit: true,
        autoApprove: true,
      }),
      selectPipeline('feature-audit'),
      createDoctorResult({
        summary: {
          readinessLevel: 'L3',
          autonomyRecommendation: 'high-confidence-autonomy',
        },
        modules: [
          createModuleReport({
            id: 'evals',
            maxAutonomyLevel: 'L3',
            requiredRegressionSuites: ['evals-fast'],
            requiredE2ESuites: ['evals-e2e'],
            coverageSignal: 'good',
          }),
        ],
        verification: {
          version: 1,
          modulePolicies: [
            {
              id: 'evals',
              criticality: 'high',
              paths: ['apps/studio/src/features/evals/**'],
              maxAutonomyLevel: 'L3',
              requiredSuites: {
                regression: ['evals-fast'],
                e2e: ['evals-e2e'],
              },
            },
          ],
        },
      }),
    );

    expect(policy.effectiveConfig.autoCommit).toBe(true);
    expect(policy.effectiveConfig.autoApprove).toBe(true);
    expect(policy.effectiveConfig.autonomy?.mode).toBe('thresholded');
    expect(policy.effectiveConfig.autonomy?.moduleTrustProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'verification:evals',
          confidenceBoost: 2,
          maxAutoCommitRisk: 'medium',
        }),
      ]),
    );
    expect(policy.startupDecision.answer).toContain('high-confidence-autonomy');
  });

  it('merges repo runtime overrides for stage routing and MCP servers into the effective config', () => {
    const runtime: {
      stageModelPolicy: HelixStageModelPolicy;
      mcpServers: Record<string, HelixMcpServerDefinition>;
    } = {
      stageModelPolicy: {
        architectureReview: {
          preferredEngine: 'codex-cli',
          defaultPrimary: {
            engine: 'codex-cli',
            model: 'gpt-5.5',
          },
        },
      },
      mcpServers: {
        helix: {
          command: 'pnpm',
          args: ['exec', 'tsx', 'packages/helix/src/mcp-cli.ts', '--workdir', '.'],
        },
      },
    };

    const policy = buildRuntimeReadinessPolicy(
      createBaseConfig(),
      selectPipeline('feature-audit'),
      createDoctorResult({
        summary: {
          readinessLevel: 'L2',
          autonomyRecommendation: 'targeted-autonomy',
        },
        runtime,
      }),
    );

    expect(policy.effectiveConfig.stageModelPolicy?.architectureReview).toMatchObject({
      preferredEngine: 'codex-cli',
      defaultPrimary: {
        engine: 'codex-cli',
        model: 'gpt-5.5',
      },
    });
    expect(policy.effectiveConfig.mcpServers?.helix).toEqual(runtime.mcpServers.helix);
  });
});

function createBaseConfig(
  overrides: Partial<Pick<HelixConfig, 'autoCommit' | 'autoApprove'>> = {},
): HelixConfig {
  return {
    workDir: '/repo',
    sessionDir: '/repo/.helix/sessions',
    journalDir: '/repo/docs/sdlc-logs',
    defaultModel: {
      engine: 'codex-cli',
      model: 'gpt-5.5',
      effort: 'high',
      maxTurns: 40,
    },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 4,
    maxSliceRetries: 3,
    autoCommit: overrides.autoCommit ?? false,
    autoApprove: overrides.autoApprove ?? false,
    autonomy: {
      mode: 'thresholded',
      autoCommitMaxRisk: 'low',
      minConfidenceScore: 6,
      highConfidenceScore: 9,
      deferBulkReview: true,
    },
    budgetLimitUsd: 200,
    verbose: false,
  };
}

function createDoctorResult(overrides: {
  summary: Pick<HelixDoctorReport['summary'], 'readinessLevel' | 'autonomyRecommendation'>;
  modules?: HelixDoctorModuleReport[];
  verification?: Partial<HelixVerificationContract>;
  runtime?: {
    stageModelPolicy?: HelixStageModelPolicy;
    mcpServers?: Record<string, HelixMcpServerDefinition>;
  };
}): HelixDoctorRunResult {
  const contracts = createContracts(overrides.verification, overrides.runtime);
  const report: HelixDoctorReport = {
    formatVersion: 1,
    generatedAt: '2026-04-06T00:00:00.000Z',
    repo: {
      id: 'example-platform',
      displayName: 'Example Platform',
      path: '/repo',
    },
    summary: {
      readinessLevel: overrides.summary.readinessLevel,
      autonomyRecommendation: overrides.summary.autonomyRecommendation,
      counts: {
        pass: 10,
        warn: overrides.summary.readinessLevel === 'L0' ? 1 : 0,
        fail: 0,
        skip: 0,
      },
    },
    commands: {},
    environment: {
      rootExamples: ['.env.example'],
      applicationExamples: ['apps/runtime/.env.example'],
      missingExamples: [],
    },
    services: [],
    checklists: [],
    modules: overrides.modules ?? [],
    nextActions: [],
  };

  return {
    contracts,
    report,
    reportPath: '/repo/.helix/readiness-report.json',
  };
}

function createContracts(
  verification: Partial<HelixVerificationContract> | undefined,
  runtime:
    | {
        stageModelPolicy?: HelixStageModelPolicy;
        mcpServers?: Record<string, HelixMcpServerDefinition>;
      }
    | undefined,
): HelixReadinessContracts {
  return {
    configPath: '/repo/helix.config.yaml',
    verificationPath: '/repo/helix.verification.yaml',
    config: {
      version: 1,
      repo: {
        id: 'example-platform',
        displayName: 'Example Platform',
        kind: 'monorepo',
        packageManager: 'pnpm',
        ...(runtime ? { runtime } : {}),
      },
    },
    verification: {
      version: 1,
      ...(verification ?? {}),
    },
  };
}

function createModuleReport(
  overrides: Partial<HelixDoctorModuleReport> & Pick<HelixDoctorModuleReport, 'id'>,
): HelixDoctorModuleReport {
  return {
    id: overrides.id,
    criticality: overrides.criticality ?? 'critical',
    status: overrides.status ?? 'pass',
    maxAutonomyLevel: overrides.maxAutonomyLevel ?? 'L1',
    requiredRegressionSuites: overrides.requiredRegressionSuites ?? [],
    requiredE2ESuites: overrides.requiredE2ESuites ?? [],
    coverageSignal: overrides.coverageSignal ?? 'good',
    remediation: overrides.remediation ?? '',
    evidence: overrides.evidence ?? [],
  };
}

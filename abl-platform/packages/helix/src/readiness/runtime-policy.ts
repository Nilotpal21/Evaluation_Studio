import type {
  AutonomyEvidenceSignal,
  AutonomyPolicyConfig,
  Decision,
  HelixConfig,
  ModuleTrustProfile,
  PipelineTemplate,
  StageDefinition,
} from '../types.js';
import { mergeMcpServers, mergeStageModelPolicy } from '../runtime-config.js';
import type {
  HelixDoctorModuleReport,
  HelixDoctorRunResult,
  HelixReadinessLevel,
  HelixModuleVerificationPolicy,
} from './doctor.js';

const READINESS_DECISION_QUESTION = 'What repo readiness policy should govern this HELIX run?';
const READINESS_DECISION_STAGE = 'Readiness Bootstrap';
const READINESS_OVERRIDE_STAGE_NAME = 'Readiness Override Approval';
const MUTATING_STAGE_TOOLS = ['Write', 'Edit'] as const;

export interface HelixRuntimeReadinessPolicy {
  reportPath: string;
  effectiveConfig: HelixConfig;
  effectivePipeline: PipelineTemplate;
  startupDecision: Decision;
  summaryLines: string[];
}

export function buildRuntimeReadinessPolicy(
  baseConfig: HelixConfig,
  pipeline: PipelineTemplate,
  doctorResult: HelixDoctorRunResult,
): HelixRuntimeReadinessPolicy {
  const recommendation = doctorResult.report.summary.autonomyRecommendation;
  const derivedTrustProfiles = buildDerivedTrustProfiles(doctorResult);
  const effectiveAutonomy = buildEffectiveAutonomyPolicy(
    baseConfig.autonomy,
    derivedTrustProfiles,
    recommendation,
  );
  const requiresManualSafetyRail =
    recommendation === 'audit-only' || recommendation === 'characterize-first';
  const effectiveConfig: HelixConfig = {
    ...baseConfig,
    stageModelPolicy: mergeStageModelPolicy(
      baseConfig.stageModelPolicy,
      doctorResult.contracts.config.repo.runtime?.stageModelPolicy,
    ),
    mcpServers: mergeMcpServers(
      baseConfig.mcpServers,
      doctorResult.contracts.config.repo.runtime?.mcpServers,
    ),
    // Readiness rail: when the user explicitly requested auto-approve / auto-commit
    // (e.g. for headless / nohup execution), respect their choice — the summary
    // lines already warn that manual mode is recommended.  Only downgrade when the
    // user did NOT explicitly opt-in (i.e. the flags are still at their defaults).
    autoCommit: baseConfig.autoCommit || !requiresManualSafetyRail ? baseConfig.autoCommit : false,
    autoApprove:
      baseConfig.autoApprove || !requiresManualSafetyRail ? baseConfig.autoApprove : false,
    autonomy: effectiveAutonomy,
  };
  const auditOnlyPipeline =
    recommendation === 'audit-only' ? insertAuditOnlyCheckpoint(pipeline) : null;
  const effectivePipeline = auditOnlyPipeline?.pipeline ?? {
    ...pipeline,
    stages: [...pipeline.stages],
  };

  return {
    reportPath: doctorResult.reportPath,
    effectiveConfig,
    effectivePipeline,
    startupDecision: buildReadinessDecision(doctorResult, effectiveConfig),
    summaryLines: buildSummaryLines(
      doctorResult,
      derivedTrustProfiles,
      auditOnlyPipeline?.insertedCheckpoint ?? false,
      effectiveConfig,
    ),
  };
}

function buildEffectiveAutonomyPolicy(
  basePolicy: AutonomyPolicyConfig | undefined,
  derivedTrustProfiles: ModuleTrustProfile[],
  recommendation: HelixDoctorRunResult['report']['summary']['autonomyRecommendation'],
): AutonomyPolicyConfig | undefined {
  const mergedProfiles = mergeTrustProfiles(basePolicy?.moduleTrustProfiles, derivedTrustProfiles);
  const nextMode =
    recommendation === 'audit-only' || recommendation === 'characterize-first'
      ? 'manual'
      : basePolicy?.mode;

  if (!basePolicy && mergedProfiles.length === 0 && !nextMode) {
    return undefined;
  }

  return {
    ...basePolicy,
    ...(nextMode ? { mode: nextMode } : {}),
    ...(mergedProfiles.length > 0 ? { moduleTrustProfiles: mergedProfiles } : {}),
  };
}

function mergeTrustProfiles(
  baseProfiles: ModuleTrustProfile[] | undefined,
  derivedProfiles: ModuleTrustProfile[],
): ModuleTrustProfile[] {
  const merged: ModuleTrustProfile[] = [];

  for (const profile of baseProfiles ?? []) {
    upsertTrustProfile(merged, profile);
  }

  for (const profile of derivedProfiles) {
    upsertTrustProfile(merged, profile);
  }

  return merged;
}

function buildDerivedTrustProfiles(doctorResult: HelixDoctorRunResult): ModuleTrustProfile[] {
  return (doctorResult.contracts.verification.modulePolicies ?? []).map((policy) =>
    buildTrustProfile(
      policy,
      doctorResult.report.modules.find((moduleReport) => moduleReport.id === policy.id),
    ),
  );
}

function buildTrustProfile(
  policy: HelixModuleVerificationPolicy,
  moduleReport: HelixDoctorModuleReport | undefined,
): ModuleTrustProfile {
  const regressionSuites = policy.requiredSuites?.regression ?? [];
  const e2eSuites = policy.requiredSuites?.e2e ?? [];
  const requiredSignals = uniqueSignals([
    ...(regressionSuites.length > 0 ? (['regression-suite'] as const) : []),
    ...(e2eSuites.length > 0 ? (['e2e'] as const) : []),
  ]);
  const coverageSignal = moduleReport?.coverageSignal ?? 'missing';
  const coverageNote =
    coverageSignal === 'good'
      ? 'Coverage is mapped to regression and E2E evidence.'
      : coverageSignal === 'partial'
        ? 'Coverage is partial, so characterize-first evidence is still required before higher autonomy.'
        : 'Coverage mapping is missing or currently failing readiness checks.';
  const suiteNote = [
    `Regression suites: ${regressionSuites.join(', ') || '(none)'}.`,
    `E2E suites: ${e2eSuites.join(', ') || '(none)'}.`,
  ].join(' ');

  return {
    name: `verification:${policy.id}`,
    pathPatterns: [...policy.paths],
    confidenceBoost: mapConfidenceBoost(policy.maxAutonomyLevel, coverageSignal),
    maxAutoCommitRisk: mapMaxAutoCommitRisk(policy.maxAutonomyLevel, coverageSignal),
    requiredSignals: requiredSignals.length > 0 ? requiredSignals : undefined,
    notes: `${policy.criticality} module policy. ${suiteNote} ${coverageNote}`.trim(),
  };
}

function mapConfidenceBoost(
  level: HelixReadinessLevel,
  coverageSignal: HelixDoctorModuleReport['coverageSignal'],
): number | undefined {
  if (coverageSignal !== 'good') {
    return undefined;
  }

  switch (level) {
    case 'L3':
      return 2;
    case 'L2':
      return 1;
    default:
      return undefined;
  }
}

function mapMaxAutoCommitRisk(
  level: HelixReadinessLevel,
  coverageSignal: HelixDoctorModuleReport['coverageSignal'],
): ModuleTrustProfile['maxAutoCommitRisk'] {
  if (coverageSignal !== 'good') {
    return undefined;
  }

  switch (level) {
    case 'L3':
      return 'medium';
    default:
      return undefined;
  }
}

function uniqueSignals(signals: AutonomyEvidenceSignal[]): AutonomyEvidenceSignal[] {
  const unique: AutonomyEvidenceSignal[] = [];
  for (const signal of signals) {
    if (!unique.includes(signal)) {
      unique.push(signal);
    }
  }
  return unique;
}

function insertAuditOnlyCheckpoint(pipeline: PipelineTemplate): {
  pipeline: PipelineTemplate;
  insertedCheckpoint: boolean;
} {
  if (pipeline.stages.some((stage) => stage.name === READINESS_OVERRIDE_STAGE_NAME)) {
    return {
      pipeline: {
        ...pipeline,
        stages: [...pipeline.stages],
      },
      insertedCheckpoint: false,
    };
  }

  const firstMutatingStageIndex = pipeline.stages.findIndex(isMutatingStage);
  if (firstMutatingStageIndex < 0) {
    return {
      pipeline: {
        ...pipeline,
        stages: [...pipeline.stages],
      },
      insertedCheckpoint: false,
    };
  }

  const previousStage = pipeline.stages[firstMutatingStageIndex - 1];
  if (previousStage?.type === 'user-checkpoint') {
    return {
      pipeline: {
        ...pipeline,
        stages: [...pipeline.stages],
      },
      insertedCheckpoint: false,
    };
  }

  const stages = [...pipeline.stages];
  stages.splice(firstMutatingStageIndex, 0, {
    name: READINESS_OVERRIDE_STAGE_NAME,
    type: 'user-checkpoint',
    description:
      'HELIX doctor marked this repo audit-only. Review the readiness gaps and explicitly approve before any write-enabled stage runs.',
    model: {
      primary: {
        engine: 'claude-code',
      },
    },
    canLoop: false,
    maxLoopIterations: 1,
    checkpoint: 'user-approval',
  });

  return {
    pipeline: {
      ...pipeline,
      stages,
    },
    insertedCheckpoint: true,
  };
}

function isMutatingStage(stage: StageDefinition): boolean {
  return (stage.tools ?? []).some((tool) =>
    MUTATING_STAGE_TOOLS.includes(tool as (typeof MUTATING_STAGE_TOOLS)[number]),
  );
}

function upsertTrustProfile(profiles: ModuleTrustProfile[], profile: ModuleTrustProfile): void {
  const existingIndex = profiles.findIndex((entry) => entry.name === profile.name);
  if (existingIndex >= 0) {
    profiles[existingIndex] = profile;
    return;
  }
  profiles.push(profile);
}

function buildReadinessDecision(
  doctorResult: HelixDoctorRunResult,
  effectiveConfig: HelixConfig,
): Decision {
  const recommendation = doctorResult.report.summary.autonomyRecommendation;
  const readinessLevel = doctorResult.report.summary.readinessLevel;
  const manualModeWithOverrides =
    isManualSafetyRailRecommendation(recommendation) && hasAutoOptIn(effectiveConfig);
  const answer =
    recommendation === 'audit-only'
      ? manualModeWithOverrides
        ? `Repo readiness is ${readinessLevel} / audit-only. Stay in manual mode for readiness and autonomy scoring, but ${describeAutoFlagState(effectiveConfig)} because you explicitly opted in. HELIX will still inject the readiness override checkpoint before the first write-enabled stage.`
        : `Repo readiness is ${readinessLevel} / audit-only. Stay in manual mode, keep auto-commit and auto-approve off, and require explicit approval before any write-enabled stage proceeds.`
      : recommendation === 'characterize-first'
        ? manualModeWithOverrides
          ? `Repo readiness is ${readinessLevel} / characterize-first. Stay in manual mode for readiness and autonomy scoring, but ${describeAutoFlagState(effectiveConfig)} because you explicitly opted in. Establish or refresh characterization, regression, or E2E evidence for affected modules before risky edits.`
          : `Repo readiness is ${readinessLevel} / characterize-first. Stay in manual mode, keep auto-commit and auto-approve off, and establish or refresh characterization, regression, or E2E evidence for affected modules before risky edits.`
        : recommendation === 'targeted-autonomy'
          ? `Repo readiness is ${readinessLevel} / targeted-autonomy. Preserve the requested run mode, but only trust higher-confidence autonomy when module-specific regression and E2E evidence remains satisfied.`
          : `Repo readiness is ${readinessLevel} / high-confidence-autonomy. Preserve the requested run mode, but continue to verify slice autonomy against module-specific regression and E2E evidence.`;

  return {
    id: `readiness-${doctorResult.report.generatedAt}`,
    question: READINESS_DECISION_QUESTION,
    context: [
      `HELIX doctor report: ${doctorResult.reportPath}`,
      `Repo: ${doctorResult.report.repo.displayName} (${doctorResult.report.repo.id})`,
      `Counts: ${doctorResult.report.summary.counts.pass} pass, ${doctorResult.report.summary.counts.warn} warn, ${doctorResult.report.summary.counts.fail} fail, ${doctorResult.report.summary.counts.skip} skip`,
    ].join('\n'),
    classification: 'DECIDED',
    answer,
    oracleVotes: [],
    stage: READINESS_DECISION_STAGE,
  };
}

function buildSummaryLines(
  doctorResult: HelixDoctorRunResult,
  derivedTrustProfiles: ModuleTrustProfile[],
  insertedAuditOnlyCheckpoint: boolean,
  effectiveConfig: HelixConfig,
): string[] {
  const recommendation = doctorResult.report.summary.autonomyRecommendation;
  const lines = [`Readiness: ${doctorResult.report.summary.readinessLevel} (${recommendation})`];
  const manualModeWithOverrides =
    isManualSafetyRailRecommendation(recommendation) && hasAutoOptIn(effectiveConfig);

  switch (recommendation) {
    case 'audit-only':
      lines.push(
        manualModeWithOverrides
          ? insertedAuditOnlyCheckpoint
            ? `Run policy: ${capitalizeSentence(describeAutoFlagState(effectiveConfig))}. HELIX still injects the readiness override checkpoint before the first write-enabled stage because the repo is audit-only.`
            : `Run policy: ${capitalizeSentence(describeAutoFlagState(effectiveConfig))}. HELIX still stays in audit-only/manual mode for write-enabled work.`
          : insertedAuditOnlyCheckpoint
            ? 'Run policy: auto-commit and auto-approve are disabled, and HELIX will pause for explicit approval before the first write-enabled stage.'
            : 'Run policy: auto-commit and auto-approve are disabled, and HELIX will stay behind explicit manual checkpoints before any write-enabled work continues.',
      );
      break;
    case 'characterize-first':
      lines.push(
        manualModeWithOverrides
          ? `Run policy: ${capitalizeSentence(describeAutoFlagState(effectiveConfig))}. HELIX will still bias planning toward characterization, regression, and E2E evidence before risky edits.`
          : 'Run policy: auto-commit and auto-approve are disabled, and HELIX will bias planning toward characterization, regression, and E2E evidence before risky edits.',
      );
      break;
    case 'targeted-autonomy':
      lines.push(
        'Run policy: requested autonomy is preserved, but module-specific trust profiles will gate slice confidence and auto-commit eligibility.',
      );
      break;
    case 'high-confidence-autonomy':
      lines.push(
        'Run policy: requested autonomy is preserved, with module-specific trust profiles reinforcing slice confidence and auto-commit eligibility.',
      );
      break;
  }

  if (derivedTrustProfiles.length > 0) {
    lines.push(
      `Module trust profiles: derived ${derivedTrustProfiles.length} profile(s) from helix.verification.yaml.`,
    );
  }

  lines.push(`Readiness report: ${doctorResult.reportPath}`);
  return lines;
}

function isManualSafetyRailRecommendation(
  recommendation: HelixDoctorRunResult['report']['summary']['autonomyRecommendation'],
): boolean {
  return recommendation === 'audit-only' || recommendation === 'characterize-first';
}

function hasAutoOptIn(config: HelixConfig): boolean {
  return config.autoCommit || config.autoApprove;
}

function describeAutoFlagState(config: HelixConfig): string {
  if (config.autoCommit && config.autoApprove) {
    return 'requested auto-commit and auto-approve remain enabled';
  }

  if (config.autoCommit) {
    return 'requested auto-commit remains enabled while auto-approve stays disabled';
  }

  if (config.autoApprove) {
    return 'requested auto-approve remains enabled while auto-commit stays disabled';
  }

  return 'auto-commit and auto-approve remain disabled';
}

function capitalizeSentence(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

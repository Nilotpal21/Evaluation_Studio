import { randomUUID } from 'node:crypto';

import type { ModelRouter } from '../models/model-router.js';
import {
  buildOracleFailureSignature,
  computeOracleFindingsHash,
  createOracleCheckpoint,
  getOracleCheckpoint,
  upsertHarnessDefect,
  upsertOracleCheckpoint,
} from '../pipeline/control-plane-state.js';
import { parseStructuredStageOutputResult } from '../pipeline/stage-output-parsers.js';
import { buildStageOutputInstructions } from '../pipeline/stage-output-schema.js';
import type {
  Decision,
  DecisionClassification,
  ExecutorEfficiencyBudget,
  ExecutorResult,
  Finding,
  FindingHorizon,
  FindingSeverity,
  HelixConfig,
  OracleDefinition,
  OracleFindingAssessmentRecord,
  OracleReviewStageOutput,
  OracleVote,
  ProgressReporter,
  Session,
  StreamEvent,
  StructuredFindingRecord,
} from '../types.js';
import { accumulateProviderCost } from '../pipeline/cost-accumulator.js';

interface OracleExecutionResult {
  oracle: OracleDefinition;
  review: OracleReviewStageOutput;
  reusedCheckpoint?: boolean;
}

interface FindingAssessmentVote {
  findingId: string;
  vote: OracleVote;
  assessment: OracleFindingAssessmentRecord;
}

export interface OracleAnalysisResult {
  additionalFindings: Finding[];
  decisions: Decision[];
  output: string;
  successfulOracles: number;
  reusedOracles: number;
  failedOracles: Array<{ oracle: string; error: string }>;
}

/**
 * Oracle Constellation — specialized oracles that review the same findings,
 * then converge via per-finding quorum instead of acting as independent sidecars.
 */
export class OracleConstellation {
  private readonly oracles: OracleDefinition[];
  private readonly config?: HelixConfig;

  constructor(
    private readonly modelRouter: Pick<ModelRouter, 'execute'>,
    private readonly reporter: ProgressReporter,
    customOracles?: OracleDefinition[],
    private readonly maxConcurrentOracles: number = 8,
    config?: HelixConfig,
  ) {
    this.config = config;
    this.oracles = customOracles ?? buildDefaultOracles(config);
  }

  async analyzeFindings(
    findings: Finding[],
    session: Session,
    options: {
      stageName?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<OracleAnalysisResult> {
    const stageName = options.stageName ?? 'Oracle Analysis';
    const deadlineAt = resolveDeadlineAt(options.timeoutMs);
    const findingsHash = computeOracleFindingsHash(findings);

    const runs = await mapWithConcurrency(
      this.oracles,
      this.maxConcurrentOracles,
      async (oracle) => {
        const checkpoint = getOracleCheckpoint(session, stageName, oracle.id, findingsHash);
        if (checkpoint) {
          this.reporter.emit({
            type: 'oracle-vote',
            timestamp: new Date().toISOString(),
            stage: stageName,
            message: `${oracle.name}: reused persisted checkpoint`,
            details: { oracle: oracle.name, status: 'checkpoint-reused' },
          });
          return {
            oracle,
            review: checkpoint.review,
            reusedCheckpoint: true,
          };
        }

        const stageTimeoutMs = getRemainingTimeoutMs(deadlineAt);
        if (stageTimeoutMs != null && stageTimeoutMs <= 0) {
          throw new Error(`${stageName} exceeded its execution deadline`);
        }

        const prompt = buildOraclePrompt(oracle, findings, session, stageName);
        const tunedModel = tuneOracleModelSpec(oracle, findings, session, stageName);
        const startInSynthesisMode = shouldDisableReplayOracleToolUse(findings, session, stageName);
        const reviewPrompt = startInSynthesisMode
          ? buildOracleSynthesisPrompt(
              prompt,
              'Deep scan already gathered sufficient replay seam evidence for oracle review.',
              findings,
            )
          : prompt;
        const reviewModel = startInSynthesisMode
          ? buildOracleSynthesisModelSpec(tunedModel, this.config)
          : tunedModel;
        const reviewTools = deriveOracleTools(
          oracle,
          findings,
          session,
          startInSynthesisMode,
          stageName,
        );
        const timeoutMs = deriveOracleExecutionTimeoutMs(
          oracle,
          stageTimeoutMs,
          findings,
          session,
          startInSynthesisMode,
        );

        const result = await this.executeOracleReview(
          oracle,
          stageName,
          reviewPrompt,
          reviewModel,
          reviewTools,
          timeoutMs,
          session,
        ).catch(async (error) => {
          if (
            shouldRetryOracleInSynthesisMode(error) &&
            shouldEnableOracleSynthesisRetry(session)
          ) {
            this.reporter.emit({
              type: 'oracle-vote',
              timestamp: new Date().toISOString(),
              stage: stageName,
              message: `${oracle.name}: synthesis retry after ${error.message}`,
              details: { oracle: oracle.name, mode: 'synthesis-retry' },
            });

            return this.executeOracleReview(
              oracle,
              stageName,
              buildOracleSynthesisPrompt(prompt, error.message, findings),
              buildOracleSynthesisModelSpec(tunedModel, this.config),
              deriveOracleTools(oracle, findings, session, true, stageName),
              deriveOracleExecutionTimeoutMs(oracle, stageTimeoutMs, findings, session, true),
              session,
            );
          }

          throw error;
        });

        return {
          oracle,
          review: (() => {
            const parsed = parseStructuredStageOutputResult(result.output, 'oracle-review');
            if (!parsed.data) {
              throw new Error(parsed.error.message);
            }
            return parsed.data;
          })(),
        };
      },
    );

    const successful: OracleExecutionResult[] = [];
    const failedOracles: Array<{ oracle: string; error: string }> = [];
    let reusedOracles = 0;

    for (const [index, run] of runs.entries()) {
      if (run instanceof Error) {
        failedOracles.push({
          oracle: this.oracles[index]?.name ?? `oracle-${index + 1}`,
          error: run.message,
        });
      } else {
        successful.push(run);
        if (run.reusedCheckpoint) {
          reusedOracles += 1;
        } else {
          upsertOracleCheckpoint(
            session,
            createOracleCheckpoint(
              stageName,
              run.oracle.id,
              run.oracle.name,
              findingsHash,
              run.review,
            ),
          );
        }
      }
    }

    for (const failure of failedOracles) {
      upsertHarnessDefect(session, {
        kind: 'oracle',
        stageName,
        actor: failure.oracle,
        signature: buildOracleFailureSignature(failure.oracle, failure.error),
        sample: failure.error,
      });
      this.reporter.emit({
        type: 'oracle-vote',
        timestamp: new Date().toISOString(),
        stage: stageName,
        message: `${failure.oracle}: failed — ${failure.error}`,
        details: { oracle: failure.oracle, status: 'failed' },
      });
    }

    if (successful.length === 0) {
      return {
        additionalFindings: [],
        decisions: [],
        output: 'All oracles failed',
        successfulOracles: 0,
        reusedOracles: 0,
        failedOracles,
      };
    }

    const quorum = Math.max(1, Math.ceil(successful.length / 2));
    const assessmentVotes = collectAssessmentVotes(successful);
    const decisions = [
      ...buildAssessmentConsensusDecisions(
        findings,
        assessmentVotes,
        successful.length,
        quorum,
        stageName,
      ),
      ...buildExplicitDecisionConsensus(successful, successful.length, quorum, stageName),
    ];
    const additionalFindings = buildConsensusFindings(successful, quorum, stageName);
    const output = buildOracleSummary(successful, failedOracles, additionalFindings, decisions);

    return {
      additionalFindings,
      decisions,
      output,
      successfulOracles: successful.length,
      reusedOracles,
      failedOracles,
    };
  }

  private async executeOracleReview(
    oracle: OracleDefinition,
    stageName: string,
    prompt: string,
    primary: OracleDefinition['model'],
    tools: string[],
    timeoutMs?: number,
    session?: Session,
  ): Promise<ExecutorResult> {
    const onStream = (event: StreamEvent): void => {
      if (event.type === 'output' || event.type === 'progress') {
        this.reporter.emit({
          type: 'oracle-vote',
          timestamp: new Date().toISOString(),
          stage: stageName,
          message: `${oracle.name}: ${event.message}`,
          details: { oracle: oracle.name },
        });
      }
    };

    const result = await this.modelRouter.execute(
      prompt,
      { primary },
      tools,
      onStream,
      { id: 'oracle-review', strict: true },
      timeoutMs,
    );

    if (session) {
      accumulateProviderCost(session, result);
    }

    if (result.error) {
      throw new Error(result.error);
    }

    return result;
  }
}

export function applyOracleDecisionOutcome(session: Session, decision: Decision): boolean {
  if (!decision.answer || !decision.context) {
    return false;
  }

  const findingIdMatch = decision.context.match(/\[finding-id:([^\]]+)\]/);
  const actionMatch = decision.context.match(/\[action:(status|severity|horizon)\]/);
  const proposalMatch = decision.context.match(/\[proposal:([^\]]+)\]/);
  if (!findingIdMatch || !actionMatch) {
    return false;
  }

  const finding = session.findings.find((candidate) => candidate.id === findingIdMatch[1]);
  if (!finding) {
    return false;
  }

  const action = actionMatch[1];
  const normalizedAnswer = decision.answer.trim().toLowerCase();
  const proposedValue = proposalMatch?.[1]?.trim().toLowerCase();

  if (action === 'status') {
    const nextStatus = resolveFindingStatusAnswer(normalizedAnswer, proposedValue);
    if (!nextStatus) {
      return false;
    }
    finding.status = nextStatus;
    finding.updatedAt = new Date().toISOString();
    return true;
  }

  if (action === 'severity') {
    const nextSeverity = resolveFindingSeverityAnswer(normalizedAnswer, proposedValue);
    if (!nextSeverity) {
      return false;
    }
    finding.severity = nextSeverity;
    finding.updatedAt = new Date().toISOString();
    return true;
  }

  if (action === 'horizon') {
    const nextHorizon = resolveFindingHorizonAnswer(normalizedAnswer, proposedValue);
    if (!nextHorizon) {
      return false;
    }
    finding.horizon = nextHorizon;
    finding.updatedAt = new Date().toISOString();
    return true;
  }

  return false;
}

// ── Default Oracle Definitions ────────────────────────────────

const ARCHITECTURE_ORACLE_OPUS: OracleDefinition = {
  id: 'architecture',
  name: 'Architecture Oracle',
  description: 'Evaluates against platform principles, patterns, consistency',
  model: {
    engine: 'claude-code',
    model: 'opus',
    maxTurns: 20,
    maxBudgetUsd: 10,
  },
  promptFile: 'architecture-oracle.md',
  focusAreas: ['isolation', 'auth', 'stateless', 'traceability', 'error-handling'],
  tools: ['Read', 'Grep', 'Glob'],
};

/**
 * Returns the GPT-5 Architecture oracle entry when `config.useOpenAiArchitectureOracle`
 * is true, otherwise the existing Opus variant.
 */
export function resolveArchitectureOracle(config: HelixConfig): OracleDefinition {
  if (config.useOpenAiArchitectureOracle) {
    return {
      ...ARCHITECTURE_ORACLE_OPUS,
      model: {
        engine: 'openai-api',
        model: config.openaiModel ?? 'gpt-5',
        maxTurns: ARCHITECTURE_ORACLE_OPUS.model.maxTurns,
        maxBudgetUsd: ARCHITECTURE_ORACLE_OPUS.model.maxBudgetUsd,
      },
    };
  }
  return ARCHITECTURE_ORACLE_OPUS;
}

function buildDefaultOracles(config?: HelixConfig): OracleDefinition[] {
  const architectureEntry =
    config?.useOpenAiArchitectureOracle === true
      ? resolveArchitectureOracle(config)
      : ARCHITECTURE_ORACLE_OPUS;

  return [
    {
      id: 'codebase',
      name: 'Codebase Oracle',
      description: 'Analyzes actual code: imports, exports, dead code, redundancies',
      model: {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 40,
        maxBudgetUsd: 5,
      },
      promptFile: 'codebase-oracle.md',
      focusAreas: ['imports', 'exports', 'dead-code', 'redundancy', 'wiring'],
      tools: ['Read', 'Grep', 'Glob'],
    },
    architectureEntry,
    {
      id: 'testing',
      name: 'Testing Oracle',
      description: 'Evaluates test quality, coverage gaps, mock usage',
      model: {
        engine: 'claude-code',
        model: 'opus',
        maxTurns: 20,
        maxBudgetUsd: 10,
      },
      promptFile: 'testing-oracle.md',
      focusAreas: ['coverage', 'e2e', 'integration', 'mocks', 'false-confidence'],
      tools: ['Read', 'Grep', 'Glob'],
    },
    {
      id: 'domain',
      name: 'Domain Oracle',
      description: 'Evaluates feature correctness against spec and user stories',
      model: {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 40,
        maxBudgetUsd: 10,
      },
      promptFile: 'domain-oracle.md',
      focusAreas: ['spec-compliance', 'edge-cases', 'user-experience', 'completeness'],
      tools: ['Read', 'Grep', 'Glob'],
    },
    {
      id: 'platform',
      name: 'Platform Oracle',
      description:
        'Validates against CLAUDE.md invariants, established platform patterns, and no duplicate capabilities',
      model: {
        engine: 'claude-code',
        model: 'opus',
        maxTurns: 20,
        maxBudgetUsd: 10,
      },
      promptFile: 'platform-oracle.md',
      focusAreas: ['invariants', 'patterns', 'isolation', 'wiring', 'reinvention'],
      tools: ['Read', 'Grep', 'Glob'],
    },
    {
      id: 'industry-research',
      name: 'Industry Research Oracle',
      description:
        'Web-searches for industry best practices, known failure modes, and competitive implementations',
      model: {
        engine: 'claude-code',
        model: 'opus',
        effort: 'medium',
        maxTurns: 20,
        maxBudgetUsd: 15,
      },
      promptFile: 'industry-research-oracle.md',
      focusAreas: ['best-practices', 'failure-modes', 'competitive-analysis', 'standards'],
      tools: ['Read', 'WebFetch', 'WebSearch'],
    },
    {
      id: 'e2e-flow',
      name: 'End-to-End Flow Oracle',
      description:
        'Traces feature data flow Studio → DB → DSL/IR → Runtime → response; catches boundary issues other oracles miss',
      model: {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 40,
        maxBudgetUsd: 20,
      },
      promptFile: 'e2e-flow-oracle.md',
      focusAreas: [
        'cross-layer-consistency',
        'schema-drift',
        'auth-propagation',
        'serialization',
        'error-propagation',
        'race-condition',
        'side-effect-leak',
      ],
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
    },
    {
      id: 'oss-library',
      name: 'OSS Library Oracle',
      description:
        'Web-searches for existing open-source libraries that could replace or simplify custom implementations',
      model: {
        engine: 'claude-code',
        model: 'opus',
        effort: 'medium',
        maxTurns: 20,
        maxBudgetUsd: 15,
      },
      promptFile: 'oss-library-oracle.md',
      focusAreas: ['npm-packages', 'license-compatibility', 'maintenance', 'adoption'],
      tools: ['Read', 'WebFetch', 'WebSearch'],
    },
  ];
}

function tuneOracleModelSpec(
  oracle: OracleDefinition,
  findings: Finding[],
  session: Session,
  stageName: string,
): OracleDefinition['model'] {
  const model = oracle.model;
  const changedFiles = session.replayContext?.changedFiles?.filter(Boolean) ?? [];
  const replayTags = session.replayContext?.tags ?? [];
  const isBroadReplay =
    changedFiles.length >= 6 ||
    replayTags.some((tag) => ['service-extraction', 'rbac', 'route-migration'].includes(tag));
  const uniqueFiles = new Set(
    findings.flatMap((finding) => finding.files.map((file) => file.path.trim()).filter(Boolean)),
  );
  const complexityScore = findings.length + Math.ceil(uniqueFiles.size / 4);
  const tuned = { ...model };
  const configuredMaxTurns = model.maxTurns;
  const configuredMaxBudgetUsd = model.maxBudgetUsd;
  const respectConfiguredLimits = oracle.respectConfiguredLimits === true;
  const efficiencyBudget = estimateOracleEfficiencyBudget(oracle, findings, session);
  if (efficiencyBudget) {
    tuned.efficiencyBudget = efficiencyBudget;
  }

  if (shouldDisableReplayOracleToolUse(findings, session, stageName)) {
    tuned.efficiencyBudget = {
      ...(tuned.efficiencyBudget ?? {}),
      disableToolUse: true,
      explorationTurns: 0,
      targetTurns: Math.min(tuned.efficiencyBudget?.targetTurns ?? 8, 8),
      hardTurnCap: Math.min(tuned.efficiencyBudget?.hardTurnCap ?? 12, 12),
      summary: 'Replay oracle retry: review the existing seam evidence without reopening tools.',
    };
  }

  const applyMaxTurns = (candidate: number): OracleDefinition['model'] => {
    tuned.maxTurns =
      respectConfiguredLimits && configuredMaxTurns != null
        ? Math.min(candidate, configuredMaxTurns)
        : candidate;
    return tuned;
  };

  const applyMaxBudget = (candidate: number): OracleDefinition['model'] => {
    if (configuredMaxBudgetUsd == null) {
      return tuned;
    }

    tuned.maxBudgetUsd = respectConfiguredLimits
      ? Math.min(candidate, configuredMaxBudgetUsd)
      : candidate;
    return tuned;
  };

  if (isBroadReplay) {
    applyMaxTurns(Math.min(tuned.maxTurns ?? 20, 16));
    applyMaxBudget(Math.min(tuned.maxBudgetUsd ?? 8, 8));
    tuned.stallThresholdMs =
      tuned.stallThresholdMs != null && tuned.stallThresholdMs > 0
        ? Math.min(tuned.stallThresholdMs, 45_000)
        : 45_000;
    return tuned;
  }

  if (complexityScore >= 24) {
    applyMaxTurns(Math.max(tuned.maxTurns ?? 20, 30));
    applyMaxBudget(Math.max(tuned.maxBudgetUsd ?? 12, 12));
    return tuned;
  }

  if (complexityScore >= 12) {
    applyMaxTurns(Math.max(tuned.maxTurns ?? 20, 24));
    applyMaxBudget(Math.max(tuned.maxBudgetUsd ?? 8, 8));
    return tuned;
  }

  if (complexityScore <= 4) {
    applyMaxTurns(Math.max(8, Math.min(tuned.maxTurns ?? 20, 12)));
    applyMaxBudget(Math.min(tuned.maxBudgetUsd ?? 4, 4));
    return tuned;
  }

  if (complexityScore <= 8) {
    applyMaxTurns(Math.max(10, Math.min(tuned.maxTurns ?? 20, 16)));
    applyMaxBudget(Math.min(tuned.maxBudgetUsd ?? 6, 6));
  }

  return tuned;
}

// ── Prompt & Aggregation ──────────────────────────────────────

function buildOraclePrompt(
  oracle: OracleDefinition,
  findings: Finding[],
  session: Session,
  stageName: string,
): string {
  const findingLines =
    findings.length > 0
      ? findings
          .map(
            (finding) =>
              `- ${finding.id} [${finding.severity}] [${finding.category}] ${finding.title}${finding.description ? ` :: ${finding.description}` : ''}${finding.files.length > 0 ? ` | files: ${finding.files.map((file) => file.path).join(', ')}` : ''}`,
          )
          .join('\n')
      : '(no findings supplied)';

  const sections = [
    `You are the ${oracle.name} — ${oracle.description}.`,
    '',
    `Focus areas: ${oracle.focusAreas.join(', ')}`,
    '',
    '## Feature',
    `Title: ${session.workItem.title}`,
    `Scope: ${session.workItem.scope.join(', ') || '(repo root)'}`,
    '',
    '## Existing Findings',
    findingLines,
    '',
    '## Your Task',
    'Review the findings above from your oracle perspective.',
    'For each finding you can confidently judge, add an assessment.',
    '- Use verdict "confirm" when the finding should stay in the plan.',
    '- Use verdict "challenge" when the finding should be deferred or removed from the plan.',
    '- Use verdict "reprioritize" only when the finding is valid but the severity is wrong; provide the corrected severity.',
    '- Set horizon to "immediate" or "next" only when the current implementation pass should address the finding. Use "near-term" or "long-term" for explicit follow-up work after this pass.',
    'Add only genuinely NEW findings that are missing from the list above.',
    'Add decisions only for questions that remain unresolved after your review.',
  ];

  const replayGuidance = buildOracleReplayGuidance(session, findings);
  if (replayGuidance) {
    sections.push('', replayGuidance);
  }

  if (oracle.reviewInstructions?.trim()) {
    sections.push('', '## Additional Guidance', oracle.reviewInstructions.trim());
  }

  const retryAdvisory = getOracleRetryAdvisory(session, stageName);
  if (retryAdvisory) {
    sections.push(
      '',
      '## Oracle Retry Guidance',
      `You are retrying ${stageName} after a prior stage failure: ${retryAdvisory.summary}`,
      retryAdvisory.promptGuidance?.trim() ||
        'Do not rediscover the repository. Use the existing findings and seam evidence already gathered to emit the oracle-review result now.',
      'Treat tool use as disabled unless one direct contradiction in the supplied findings absolutely requires confirmation.',
    );
  }

  sections.push('', buildStageOutputInstructions({ id: 'oracle-review', strict: true }));
  return sections.join('\n');
}

function buildOracleReplayGuidance(session: Session, findings: Finding[]): string {
  const changedFiles = session.replayContext?.changedFiles?.filter(Boolean) ?? [];
  const avoidPaths = session.replayContext?.avoidPaths?.filter(Boolean) ?? [];
  if (changedFiles.length === 0 && avoidPaths.length === 0) {
    return '';
  }

  const seamCompleteReplay = shouldDisableReplayOracleToolUse(findings, session, 'Oracle Analysis');

  const fileList = changedFiles
    .slice(0, 12)
    .map((filePath) => `- ${filePath}`)
    .join('\n');

  return `## Replay Oracle Discipline
This oracle review is part of a historical replay. Treat the existing findings and the historical changed-file seam below as the primary review surface.
${fileList}

- Do NOT rediscover the repository from scratch. Review the supplied findings first, then verify only the direct contracts needed to confirm or challenge them.
- ${seamCompleteReplay ? 'Deep Scan already covered the route/repo/model/test seam well enough for this pass. Treat the supplied findings as authoritative evidence unless you can point to one direct contradiction.' : 'If the supplied findings already cover the seam, synthesize immediately instead of reopening more files.'}
- Treat the changed-file list above as the default allowlist for first-order consumers and tests.
- Do NOT inspect unrelated runtime auth suites, E2E helpers, generic test harness utilities, settings pages, or neighboring APIs unless one of the supplied findings or already-read seam files explicitly forces you there.
- Do NOT run workspace-root inventory commands like \`ls\`, \`find .\`, \`rg --files\`, or broad directory listings of \`apps\`, \`packages\`, \`apps/studio/src\`, or \`packages/database/src/models\` once the seam above is already in hand.
- Do NOT broaden into \`permission-resolver\`, package-wide role maps, or \`vitest.config.ts\` unless a supplied finding explicitly depends on one of them.
- For test quality, prefer the nearest regression test or model test adjacent to the seam over broad inventory of every test framework in the repo.
- Missing historical future files are evidence that the seam still needs to be created; do not keep re-checking for them after the first confirmation.
- Once the route/repo/model/test seam is covered well enough to confirm or challenge the supplied findings, synthesize immediately instead of verifying one more detail.
- ${avoidPaths.length > 0 ? `Replay-specific out-of-bounds paths for this oracle pass:\n${avoidPaths.map((path) => `  - ${path}`).join('\n')}\n- Treat those paths as off-limits unless the already-read seam directly proves one is required for correctness.\n- ` : ''}If a current finding cannot be confirmed from the supplied seam plus one-hop dependencies, call that out directly instead of broadening blindly.`;
}

function estimateOracleEfficiencyBudget(
  oracle: OracleDefinition,
  findings: Finding[],
  session: Session,
): ExecutorEfficiencyBudget | undefined {
  const changedFiles = session.replayContext?.changedFiles?.filter(Boolean) ?? [];
  if (changedFiles.length === 0) {
    return undefined;
  }

  const replayTags = session.replayContext?.tags ?? [];
  const isBroadReplay =
    changedFiles.length >= 6 ||
    replayTags.some((tag) => ['service-extraction', 'rbac', 'route-migration'].includes(tag));
  const uniqueFiles = new Set(
    findings.flatMap((finding) => finding.files.map((file) => file.path.trim()).filter(Boolean)),
  );
  const targetTurns = isBroadReplay ? Math.max(12, Math.min(16, uniqueFiles.size + 6)) : 12;
  const explorationTurns = isBroadReplay ? Math.max(4, Math.min(6, targetTurns - 6)) : 5;

  const forbiddenShellPatterns = [
    '^pwd(?:\\s|$)',
    '^rg\\s+--files\\b',
    '^find\\s+(?:\\.|/)?(?:\\s|$)',
    '^ls(?:\\s+-\\S+)*\\s*$',
    '^ls(?:\\s+-\\S+)*\\s+(?:apps|packages)(?:\\s|$)',
    '^ls(?:\\s+-\\S+)*\\s+apps/studio/src(?:\\s|$)',
    '^ls(?:\\s+-\\S+)*\\s+packages/database/src/models(?:\\s|$)',
  ];

  if (oracle.id === 'testing') {
    forbiddenShellPatterns.push('vitest\\.config\\.ts');
  }

  if (oracle.id === 'domain') {
    forbiddenShellPatterns.push('permission-resolver');
  }

  return {
    targetTurns,
    explorationTurns,
    shellWarnFloor: Math.max(8, targetTurns - 3),
    shellAbortFloor: Math.max(12, targetTurns + 1),
    allowScopedShellInspection: true,
    forbiddenShellPatterns,
    summary: isBroadReplay ? 'broader replay oracle budget' : 'narrow replay oracle budget',
  };
}

function deriveOracleExecutionTimeoutMs(
  oracle: OracleDefinition,
  stageTimeoutMs: number | undefined,
  findings: Finding[],
  session: Session,
  synthesisMode: boolean,
): number | undefined {
  if (stageTimeoutMs == null) {
    return undefined;
  }

  const changedFiles = session.replayContext?.changedFiles?.filter(Boolean) ?? [];
  const isBroadReplay =
    changedFiles.length >= 6 ||
    (session.replayContext?.tags ?? []).some((tag) =>
      ['service-extraction', 'rbac', 'route-migration'].includes(tag),
    );
  const uniqueFiles = new Set(
    findings.flatMap((finding) => finding.files.map((file) => file.path.trim()).filter(Boolean)),
  );

  if (synthesisMode) {
    return Math.min(stageTimeoutMs, isBroadReplay ? 25_000 : 20_000);
  }

  const candidate = isBroadReplay
    ? 90_000 + Math.min(uniqueFiles.size, 8) * 6_000
    : 60_000 + Math.min(uniqueFiles.size, 4) * 5_000;
  return Math.min(stageTimeoutMs, candidate);
}

function shouldEnableOracleSynthesisRetry(session: Session): boolean {
  return (session.replayContext?.changedFiles?.length ?? 0) > 0;
}

function shouldRetryOracleInSynthesisMode(error: Error): boolean {
  return /\b(timeout|timed out|stalled|shell exploration budget|turn budget|hard cap)\b/i.test(
    error.message,
  );
}

function buildOracleSynthesisPrompt(
  prompt: string,
  sourceError: string,
  findings: Finding[] = [],
): string {
  const oracleHeader = prompt.split('\n')[0]?.trim() || 'You are retrying the oracle review.';
  const existingFindings = extractPromptSection(prompt, '## Existing Findings', '## Your Task');
  const structuredOutput = extractPromptSection(prompt, '## Structured Output Contract', undefined);
  const retryGuidance = extractPromptSection(
    prompt,
    '## Oracle Retry Guidance',
    '## Structured Output Contract',
  );
  const compactFindings = buildCompactOracleFindingsDigest(findings);

  if (prompt.includes('## Replay Oracle Discipline')) {
    return [
      '## TOP PRIORITY ORACLE SYNTHESIS RETRY',
      oracleHeader,
      'You already gathered enough seam evidence in the previous attempt.',
      'Do not restart discovery. Do not use AGENTS.md, docs, or workspace inventory commands.',
      'Tool use is disabled for this retry. Emit the oracle-review result directly from the existing findings and already-gathered seam evidence.',
      'If the evidence is still insufficient, emit a conservative oracle-review with an explanatory summary and empty assessments/newFindings instead of continuing exploration.',
      `Prior attempt stopped because: ${sourceError}`,
      retryGuidance ? '' : '',
      retryGuidance || '',
      '## Replay Findings Digest',
      compactFindings || existingFindings || '(no findings supplied)',
      structuredOutput || buildStageOutputInstructions({ id: 'oracle-review', strict: true }),
    ]
      .filter((line) => line.length > 0)
      .join('\n\n');
  }

  return [
    '## TOP PRIORITY ORACLE SYNTHESIS RETRY',
    'You already gathered enough seam evidence in the previous attempt.',
    'Do not restart discovery. Do not use AGENTS.md, docs, or workspace inventory commands.',
    'Assume tool use is disabled for this retry unless HELIX explicitly left you one confirming read.',
    'At most one confirming read is allowed if a single missing fact blocks the structured review.',
    'Use the existing findings plus the seam evidence already gathered to emit the oracle-review result now.',
    'If the evidence is still insufficient, emit a conservative oracle-review with an explanatory summary and empty assessments/newFindings instead of continuing exploration.',
    `Prior attempt stopped because: ${sourceError}`,
    '',
    '## Replay Findings Digest',
    compactFindings || existingFindings || '(no findings supplied)',
    '',
    structuredOutput || buildStageOutputInstructions({ id: 'oracle-review', strict: true }),
  ].join('\n');
}

function buildCompactOracleFindingsDigest(findings: Finding[]): string {
  if (findings.length === 0) {
    return '';
  }

  const lines = findings.slice(0, 10).map((finding) => {
    const files = finding.files
      .map((file) => file.path.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(', ');
    const horizon = finding.horizon ?? 'immediate';
    const description =
      finding.description && finding.description !== finding.title
        ? ` — ${truncateInlineText(finding.description, 180)}`
        : '';
    const fileSummary = files.length > 0 ? ` [files: ${files}]` : '';
    return `- [${horizon}] [${finding.severity}] [${finding.category}] ${finding.title}${fileSummary}${description}`;
  });

  if (findings.length > lines.length) {
    lines.push(`- ... and ${findings.length - lines.length} more findings`);
  }

  return lines.join('\n');
}

function truncateInlineText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildOracleSynthesisModelSpec(
  model: OracleDefinition['model'],
  _config?: HelixConfig,
): OracleDefinition['model'] {
  const fallbackModel = model.engine === 'openai-api' ? 'gpt-4o-mini' : 'claude-sonnet-4-6';

  return {
    ...model,
    model: fallbackModel,
    maxTurns: Math.min(model.maxTurns ?? 20, 4),
    maxBudgetUsd: model.maxBudgetUsd != null ? Math.min(model.maxBudgetUsd, 4) : 4,
    stallThresholdMs:
      model.stallThresholdMs != null && model.stallThresholdMs > 0
        ? Math.min(model.stallThresholdMs, 20_000)
        : 20_000,
    efficiencyBudget: {
      targetTurns: 2,
      explorationTurns: 0,
      hardTurnCap: 4,
      shellWarnFloor: 0,
      shellAbortFloor: 1,
      disableToolUse: true,
      summary:
        'Oracle synthesis retry: rely on gathered seam evidence and emit the structured review immediately.',
    },
  };
}

function extractPromptSection(prompt: string, heading: string, nextHeading?: string): string {
  const escapedHeading = escapeRegExp(heading);
  const escapedNext = nextHeading ? escapeRegExp(nextHeading) : '';
  const pattern = nextHeading
    ? new RegExp(`${escapedHeading}\\n([\\s\\S]*?)\\n${escapedNext}`)
    : new RegExp(`${escapedHeading}\\n([\\s\\S]*)$`);
  const match = prompt.match(pattern);
  return match?.[1]?.trim() ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shouldDisableReplayOracleToolUse(
  findings: Finding[],
  session: Session,
  stageName: string,
): boolean {
  const changedFiles = session.replayContext?.changedFiles?.length ?? 0;
  if (changedFiles === 0) {
    return false;
  }

  if (getOracleRetryAdvisory(session, stageName) != null) {
    return true;
  }

  const replayTags = session.replayContext?.tags ?? [];
  const isBroadReplay =
    changedFiles >= 6 ||
    replayTags.some((tag) => ['service-extraction', 'rbac', 'route-migration'].includes(tag));
  if (!isBroadReplay) {
    return false;
  }

  const seamFileCoverage = new Set(
    findings.flatMap((finding) => finding.files.map((file) => file.path.trim()).filter(Boolean)),
  ).size;
  return findings.length >= 6 || seamFileCoverage >= 5;
}

function deriveOracleTools(
  oracle: OracleDefinition,
  findings: Finding[],
  session: Session,
  synthesisMode: boolean,
  stageName: string,
): string[] {
  const configuredTools = oracle.tools ?? ['Read', 'Grep', 'Glob'];
  const changedFiles = session.replayContext?.changedFiles?.filter(Boolean) ?? [];
  const replayTags = session.replayContext?.tags ?? [];
  const isBroadReplay =
    changedFiles.length >= 6 ||
    replayTags.some((tag) => ['service-extraction', 'rbac', 'route-migration'].includes(tag));

  if (shouldDisableReplayOracleToolUse(findings, session, stageName)) {
    return [];
  }

  if (synthesisMode && changedFiles.length > 0) {
    return [];
  }

  if (!isBroadReplay) {
    return configuredTools;
  }

  return [];
}

function getOracleRetryAdvisory(
  session: Session,
  stageName: string,
): Session['pendingFailureAdvisory'] | undefined {
  if (session.pendingFailureAdvisory?.stageName === stageName) {
    return session.pendingFailureAdvisory;
  }

  const advisories = session.failureAdvisories ?? [];
  for (let index = advisories.length - 1; index >= 0; index -= 1) {
    const advisory = advisories[index];
    if (advisory.stageName === stageName && advisory.retryCount >= 1) {
      return advisory;
    }
  }

  return undefined;
}

function collectAssessmentVotes(results: OracleExecutionResult[]): FindingAssessmentVote[] {
  const votes: FindingAssessmentVote[] = [];

  for (const result of results) {
    for (const assessment of result.review.assessments) {
      votes.push({
        findingId: assessment.findingId,
        assessment,
        vote: {
          oracleId: result.oracle.id,
          oracleName: result.oracle.name,
          answer: formatAssessmentAnswer(assessment),
          confidence: inferOracleConfidence(result.oracle),
          reasoning: assessment.rationale,
          sources: [],
        },
      });
    }
  }

  return votes;
}

function buildAssessmentConsensusDecisions(
  findings: Finding[],
  assessmentVotes: FindingAssessmentVote[],
  successfulOracleCount: number,
  quorum: number,
  stageName: string,
): Decision[] {
  const votesByFinding = new Map<string, FindingAssessmentVote[]>();

  for (const vote of assessmentVotes) {
    const findingVotes = votesByFinding.get(vote.findingId) ?? [];
    findingVotes.push(vote);
    votesByFinding.set(vote.findingId, findingVotes);
  }

  const decisions: Decision[] = [];

  for (const finding of findings) {
    const votes = votesByFinding.get(finding.id) ?? [];
    if (votes.length === 0) {
      continue;
    }

    const classification = determineConsensus(
      votes.map((vote) => vote.vote),
      successfulOracleCount,
    );
    const majorityAnswer = getMajorityAnswer(
      votes.map((vote) => vote.vote),
      successfulOracleCount,
    );
    const reasons = votes
      .slice(0, 3)
      .map((vote) => `${vote.vote.oracleName}: ${vote.assessment.rationale}`)
      .join(' | ');

    if (majorityAnswer.startsWith('reprioritize:')) {
      const severity = majorityAnswer.split(':', 2)[1] as FindingSeverity | undefined;
      decisions.push({
        id: randomUUID().slice(0, 8),
        question: `What severity should finding ${finding.id} (${finding.title}) have?`,
        context: `[finding-id:${finding.id}][action:severity][proposal:${severity ?? finding.severity}] ${reasons}`,
        classification,
        answer: classification === 'AMBIGUOUS' ? undefined : severity,
        oracleVotes: votes.map((vote) => vote.vote),
        resolvedBy: classification === 'AMBIGUOUS' ? undefined : 'oracle-consensus',
        resolvedAt: classification === 'AMBIGUOUS' ? undefined : new Date().toISOString(),
        stage: stageName,
      });
    } else if (!(majorityAnswer === 'confirm' && classification === 'DECIDED')) {
      const statusProposal = majorityAnswer === 'challenge' ? 'deferred' : 'open';
      decisions.push({
        id: randomUUID().slice(0, 8),
        question: `Should finding ${finding.id} (${finding.title}) remain in the implementation plan?`,
        context: `[finding-id:${finding.id}][action:status][proposal:${statusProposal}] ${reasons}`,
        classification,
        answer:
          classification === 'AMBIGUOUS'
            ? undefined
            : majorityAnswer === 'challenge'
              ? 'defer'
              : 'keep',
        oracleVotes: votes.map((vote) => vote.vote),
        resolvedBy: classification === 'AMBIGUOUS' ? undefined : 'oracle-consensus',
        resolvedAt: classification === 'AMBIGUOUS' ? undefined : new Date().toISOString(),
        stage: stageName,
      });
    }

    const horizonVotes = votes
      .filter((vote) => vote.assessment.horizon)
      .map((vote) => ({
        ...vote.vote,
        answer: vote.assessment.horizon as string,
      }));

    if (horizonVotes.length === 0) {
      continue;
    }

    const horizonClassification = determineConsensus(horizonVotes, successfulOracleCount);
    const horizonProposal = getMajorityAnswer(horizonVotes, successfulOracleCount) as
      | FindingHorizon
      | '';
    const currentHorizon = finding.horizon ?? inferDefaultFindingHorizon(finding.severity);

    if (
      horizonProposal &&
      horizonClassification === 'DECIDED' &&
      horizonProposal === currentHorizon
    ) {
      continue;
    }

    decisions.push({
      id: randomUUID().slice(0, 8),
      question: `What delivery horizon should finding ${finding.id} (${finding.title}) have?`,
      context: `[finding-id:${finding.id}][action:horizon][proposal:${horizonProposal || currentHorizon}] ${reasons}`,
      classification: horizonClassification,
      answer: horizonClassification === 'AMBIGUOUS' ? undefined : horizonProposal || currentHorizon,
      oracleVotes: horizonVotes,
      resolvedBy: horizonClassification === 'AMBIGUOUS' ? undefined : 'oracle-consensus',
      resolvedAt: horizonClassification === 'AMBIGUOUS' ? undefined : new Date().toISOString(),
      stage: stageName,
    });
  }

  return decisions;
}

function buildConsensusFindings(
  results: OracleExecutionResult[],
  quorum: number,
  stageName: string,
): Finding[] {
  const clusters = new Map<
    string,
    Array<{ oracle: OracleDefinition; finding: StructuredFindingRecord }>
  >();

  for (const result of results) {
    for (const finding of result.review.newFindings) {
      const key = buildFindingClusterKey(finding);
      const cluster = clusters.get(key) ?? [];
      cluster.push({ oracle: result.oracle, finding });
      clusters.set(key, cluster);
    }
  }

  const consensusFindings: Finding[] = [];

  for (const cluster of clusters.values()) {
    if (cluster.length < quorum) {
      continue;
    }

    const representative = cluster[0].finding;
    const files = sortUnique(cluster.flatMap((entry) => entry.finding.files));
    const supportingOracles = cluster.map((entry) => entry.oracle.name).join(', ');
    consensusFindings.push({
      id: randomUUID().slice(0, 8),
      severity: representative.severity,
      category: representative.category,
      status: 'open',
      horizon: inferDefaultFindingHorizon(representative.severity),
      title: representative.title,
      description: `${representative.description} (supported by ${supportingOracles})`,
      files: files.map((path) => ({ path })),
      discoveredBy: stageName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return consensusFindings;
}

function buildExplicitDecisionConsensus(
  results: OracleExecutionResult[],
  successfulOracleCount: number,
  _quorum: number,
  stageName: string,
): Decision[] {
  const grouped = new Map<string, { question: string; context: string; votes: OracleVote[] }>();

  for (const result of results) {
    for (const decision of result.review.decisions) {
      const questionKey = normalizeQuestion(decision.question);
      const group = grouped.get(questionKey) ?? {
        question: decision.question,
        context: decision.context ?? '',
        votes: [],
      };
      group.votes.push({
        oracleId: result.oracle.id,
        oracleName: result.oracle.name,
        answer: decision.answer ?? decision.classification,
        confidence: inferOracleConfidence(result.oracle),
        reasoning: decision.context ?? decision.question,
        sources: [],
      });
      if (!group.context && decision.context) {
        group.context = decision.context;
      }
      grouped.set(questionKey, group);
    }
  }

  const decisions: Decision[] = [];

  for (const group of grouped.values()) {
    const classification = determineConsensus(group.votes, successfulOracleCount);
    decisions.push({
      id: randomUUID().slice(0, 8),
      question: group.question,
      context: group.context,
      classification,
      answer:
        classification === 'AMBIGUOUS'
          ? undefined
          : getMajorityAnswer(group.votes, successfulOracleCount),
      oracleVotes: group.votes,
      resolvedBy: classification === 'AMBIGUOUS' ? undefined : 'oracle-consensus',
      resolvedAt: classification === 'AMBIGUOUS' ? undefined : new Date().toISOString(),
      stage: stageName,
    });
  }

  return decisions;
}

function determineConsensus(
  votes: OracleVote[],
  eligibleVoteCount: number,
): DecisionClassification {
  if (votes.length === 0) {
    return 'AMBIGUOUS';
  }

  if (eligibleVoteCount <= 1) {
    return votes.length === 1 ? 'INFERRED' : 'AMBIGUOUS';
  }

  const groups = groupVotesByAnswer(votes);
  const maxGroupSize = Math.max(...Array.from(groups.values(), (group) => group.length));
  if (
    groups.size === 1 &&
    votes.length === eligibleVoteCount &&
    maxGroupSize === eligibleVoteCount
  ) {
    return 'DECIDED';
  }

  if (maxGroupSize >= Math.ceil(eligibleVoteCount / 2)) {
    return 'INFERRED';
  }

  return 'AMBIGUOUS';
}

function getMajorityAnswer(votes: OracleVote[], eligibleVoteCount: number): string {
  const groups = groupVotesByAnswer(votes);
  let bestAnswer = '';
  let bestSize = -1;
  let bestConfidence = -1;

  for (const [answer, group] of groups.entries()) {
    const groupConfidence = group.reduce((sum, vote) => sum + vote.confidence, 0);
    if (
      group.length > bestSize ||
      (group.length === bestSize && groupConfidence > bestConfidence) ||
      (eligibleVoteCount === 1 && bestAnswer === '')
    ) {
      bestAnswer = answer;
      bestSize = group.length;
      bestConfidence = groupConfidence;
    }
  }

  return bestAnswer;
}

function groupVotesByAnswer(votes: OracleVote[]): Map<string, OracleVote[]> {
  const grouped = new Map<string, OracleVote[]>();

  for (const vote of votes) {
    const answer = vote.answer.trim().toLowerCase();
    const group = grouped.get(answer) ?? [];
    group.push(vote);
    grouped.set(answer, group);
  }

  return grouped;
}

function buildOracleSummary(
  successful: OracleExecutionResult[],
  failed: Array<{ oracle: string; error: string }>,
  findings: Finding[],
  decisions: Decision[],
): string {
  const lines = [
    `Oracle consensus complete: ${successful.length} successful, ${failed.length} failed`,
    `Consensus findings added: ${findings.length}`,
    `Consensus decisions produced: ${decisions.length}`,
  ];

  if (failed.length > 0) {
    lines.push(`Failed oracles: ${failed.map((entry) => entry.oracle).join(', ')}`);
  }

  return lines.join('\n');
}

function buildFindingClusterKey(finding: StructuredFindingRecord): string {
  return `${finding.category}|${finding.title.trim().toLowerCase()}|${finding.files[0] ?? ''}`;
}

function formatAssessmentAnswer(assessment: OracleFindingAssessmentRecord): string {
  if (assessment.verdict === 'reprioritize') {
    return `reprioritize:${assessment.severity ?? 'medium'}`;
  }
  return assessment.verdict;
}

function inferOracleConfidence(oracle: OracleDefinition): number {
  const modelName = oracle.model.model?.toLowerCase() ?? '';
  if (modelName.includes('opus')) {
    return 0.82;
  }
  if (modelName.includes('gpt-5')) {
    return 0.82;
  }
  if (modelName.includes('gpt-4o')) {
    return 0.75;
  }
  if (modelName.includes('sonnet')) {
    return 0.72;
  }
  return 0.68;
}

function resolveFindingStatusAnswer(
  normalizedAnswer: string,
  proposedValue?: string,
): Finding['status'] | null {
  if (normalizedAnswer.includes('defer')) {
    return 'deferred';
  }
  if (normalizedAnswer.includes('keep') || normalizedAnswer.includes('confirm')) {
    return 'open';
  }
  if (proposedValue === 'deferred') {
    return 'deferred';
  }
  if (proposedValue === 'open') {
    return 'open';
  }
  return null;
}

function resolveFindingSeverityAnswer(
  normalizedAnswer: string,
  proposedValue?: string,
): FindingSeverity | null {
  const severity = proposedValue ?? normalizedAnswer;
  if (
    severity === 'critical' ||
    severity === 'high' ||
    severity === 'medium' ||
    severity === 'low' ||
    severity === 'info'
  ) {
    return severity;
  }
  return null;
}

function resolveFindingHorizonAnswer(
  normalizedAnswer: string,
  proposedValue?: string,
): FindingHorizon | null {
  const horizon = (proposedValue ?? normalizedAnswer).trim().toLowerCase();
  if (
    horizon === 'immediate' ||
    horizon === 'next' ||
    horizon === 'near-term' ||
    horizon === 'long-term'
  ) {
    return horizon;
  }
  return null;
}

function inferDefaultFindingHorizon(severity: FindingSeverity): FindingHorizon {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'immediate';
    case 'medium':
      return 'next';
    case 'low':
      return 'near-term';
    case 'info':
    default:
      return 'long-term';
  }
}

function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ');
}

function resolveDeadlineAt(timeoutMs?: number): number | undefined {
  if (timeoutMs == null || timeoutMs <= 0) {
    return undefined;
  }
  return Date.now() + timeoutMs;
}

function getRemainingTimeoutMs(deadlineAt?: number): number | undefined {
  if (deadlineAt == null) {
    return undefined;
  }
  return Math.max(deadlineAt - Date.now(), 0);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<R | Error>> {
  const limit = Math.max(1, concurrency);
  const results: Array<R | Error> = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex++;

      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        results[index] = error instanceof Error ? error : new Error(String(error));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results;
}

function sortUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

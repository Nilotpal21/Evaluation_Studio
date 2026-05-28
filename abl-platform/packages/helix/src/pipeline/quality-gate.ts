import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  AnalysisStageOutput,
  ModelReviewCheckSummary,
  PlanReviewStageOutput,
  ExecutorResult,
  QualityCheck,
  QualityGateConfig,
  QualityGateCheckResult,
  QualityGateResult,
  Session,
  StageOutputSchemaConfig,
} from '../types.js';
import {
  buildBlockingModelReviewPrompt,
  buildPlanModelReviewPrompt,
} from './model-review-prompts.js';
import {
  parseStructuredStageOutput,
  parseStructuredStageOutputResult,
} from './stage-output-parsers.js';
import {
  findModifiedWorkspacePaths,
  isTestFilePath,
  scopeEntryToWorkspaceTarget,
} from './workspace-status.js';
import { distill, type DistillKind } from '../intelligence/distill.js';
import {
  classifyTypecheckErrors,
  formatTypecheckScopeNote,
  parseTypecheckErrors,
} from './typecheck-scope-filter.js';

const execAsync = promisify(exec);

export interface QualityGateModelReviewRequest {
  check: QualityCheck;
  prompt: string;
  outputSchema: StageOutputSchemaConfig;
  timeoutMs?: number;
}

export interface QualityGateExecutionOptions {
  stageOutput?: string;
  promptContext?: string;
  scopeEntries?: string[];
  timeoutMs?: number;
  runModelReview?: (request: QualityGateModelReviewRequest) => Promise<ExecutorResult>;
}

export interface SliceVerificationCommandPacket {
  buildOrTypecheckCommand: string;
  formatCommand: string;
  requiredTestCommand?: string;
  regressionCommand?: string;
  combinedTestLockCommand?: string;
}

interface ScopedTypecheckRecoveryResult {
  passed: boolean;
  output: string;
  timedOut: boolean;
}

const SCOPED_TYPECHECK_CONFIG_PREFIX = '.helix-typecheck-';
const MAX_SCENARIO_EVIDENCE_ARTIFACTS = 200;
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const UI_EVIDENCE_EXTENSIONS = /\.(?:png|jpe?g|webm|mp4|mov|json)$/i;
const API_EVIDENCE_EXTENSIONS = /\.(?:json|txt|log|http|har)$/i;
const ARTIFACT_PATH_PATTERN =
  /(?:^|\s)(\.codex-artifacts\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+|\.helix\/evidence\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)/g;

const MODEL_REVIEW_OUTPUT_SCHEMA: StageOutputSchemaConfig = {
  id: 'analysis-report',
  strict: true,
};

/**
 * Run a quality gate — a set of automated checks that determine
 * whether a stage's output meets the required quality threshold.
 *
 * Checks can be:
 * - typecheck: Run tsc --noEmit
 * - test: Run the configured test command
 * - lint: Run prettier --check
 * - custom-script: Run an arbitrary shell command
 * - modified-test: Confirm that a scoped test file changed in the workspace
 * - scenario-evidence: Require scenario-specific Jira evidence artifacts before completion
 * - analysis-report-clear: Require the current stage's structured analysis report to have no
 *   blocking findings or unresolved decisions
 * - model-review: Run a blocking model review against the current stage output
 */
export async function runQualityGate(
  gate: QualityGateConfig,
  workDir: string,
  session: Session,
  stageName: string,
  options: QualityGateExecutionOptions = {},
): Promise<QualityGateResult> {
  const gateStartTime = Date.now();
  const gateTimeoutMs = options.timeoutMs ?? gate.timeoutMs;
  const gateDeadlineAt = resolveDeadlineAt(gateTimeoutMs);
  const results: QualityGateCheckResult[] = [];

  for (const check of gate.checks) {
    let passed = false;
    let command: string | undefined;
    let output = '';
    let timedOut = false;
    let modelReview: ModelReviewCheckSummary | undefined;
    const checkStartTime = Date.now();
    const checkTimeoutMs = getRemainingTimeoutMs(gateDeadlineAt);

    if (checkTimeoutMs != null && checkTimeoutMs <= 0) {
      results.push({
        name: check.name,
        passed: false,
        output: `Quality gate ${gate.name} timed out before check "${check.name}" could start`,
        durationMs: 0,
        timedOut: true,
        timeoutMs: gateTimeoutMs,
      });
      break;
    }

    try {
      switch (check.type) {
        case 'typecheck': {
          const cmd =
            check.command ??
            (await buildScopedTypecheckCmd(workDir, session, options.scopeEntries));
          command = cmd;
          try {
            const result = await execAsync(cmd, {
              cwd: workDir,
              timeout: clampCommandTimeout(120_000, gateDeadlineAt),
              maxBuffer: 10 * 1024 * 1024,
            });
            output = result.stdout + result.stderr;
            passed = true;
          } catch (err) {
            output = formatCommandFailure(err);
            timedOut = isTimeoutFailure(output);

            const recovered =
              !check.command && !timedOut
                ? await recoverScopedTypecheckFailure(
                    workDir,
                    session,
                    options.scopeEntries,
                    gateDeadlineAt,
                    output,
                  )
                : null;
            if (recovered) {
              output = recovered.output;
              passed = recovered.passed;
              timedOut = recovered.timedOut;
              break;
            }

            // Slice 23: when typecheck failure is entirely composed of
            // pre-existing errors in files outside the audit scope (and
            // outside the current slice's file contracts), pass with an
            // advisory note. This unblocks helix review-branch sessions
            // where the implementation gate's whole-package typecheck
            // surfaces unrelated errors that Codex can't fix in scope.
            if (!timedOut) {
              const inScopeFiles = collectInScopeFiles(session, options);
              const errors = parseTypecheckErrors(output);
              if (errors.length > 0) {
                const classification = classifyTypecheckErrors(errors, inScopeFiles);
                if (
                  classification.outOfScopeErrors.length > 0 &&
                  classification.inScopeErrors.length === 0
                ) {
                  passed = true;
                  output = formatTypecheckScopeNote(classification);
                  break;
                }
              }
            }

            passed = false;
          }
          break;
        }

        case 'test': {
          const cmd =
            check.command ?? (await buildScopedTestCmd(workDir, session, options.scopeEntries));
          command = cmd;
          try {
            const result = await execAsync(cmd, {
              cwd: workDir,
              timeout: clampCommandTimeout(300_000, gateDeadlineAt),
              maxBuffer: 10 * 1024 * 1024,
            });
            output = result.stdout + result.stderr;
            passed = true;
          } catch (err) {
            output = formatCommandFailure(err);
            timedOut = isTimeoutFailure(output);

            const focusedFallbackCmd =
              !check.command && !timedOut
                ? await buildFocusedVitestFallbackCmd(workDir, session, options.scopeEntries)
                : null;
            if (!focusedFallbackCmd) {
              const replayBaselineAllowance = maybeAllowReplayBaselineTestFailure(
                workDir,
                session,
                options.scopeEntries,
                output,
              );
              if (replayBaselineAllowance) {
                output = [output, replayBaselineAllowance].filter(Boolean).join('\n\n');
                passed = true;
                timedOut = false;
              }
              break;
            }

            try {
              const fallbackResult = await execAsync(focusedFallbackCmd, {
                cwd: workDir,
                timeout: clampCommandTimeout(300_000, gateDeadlineAt),
                maxBuffer: 10 * 1024 * 1024,
              });
              const fallbackOutput = fallbackResult.stdout + fallbackResult.stderr;
              output = [
                output,
                `Focused regression fallback passed via: ${focusedFallbackCmd}`,
                fallbackOutput,
              ]
                .filter(Boolean)
                .join('\n\n');
              passed = true;
              timedOut = false;
            } catch (fallbackErr) {
              const fallbackOutput = formatCommandFailure(fallbackErr);
              output = [
                output,
                `Focused regression fallback failed via: ${focusedFallbackCmd}`,
                fallbackOutput,
              ]
                .filter(Boolean)
                .join('\n\n');
              timedOut = timedOut || isTimeoutFailure(fallbackOutput);
            }

            const replayBaselineAllowance = maybeAllowReplayBaselineTestFailure(
              workDir,
              session,
              options.scopeEntries,
              output,
            );
            if (replayBaselineAllowance) {
              output = [output, replayBaselineAllowance].filter(Boolean).join('\n\n');
              passed = true;
              timedOut = false;
            }
          }
          break;
        }

        case 'lint': {
          const cmd =
            check.command ?? (await buildScopedLintCmd(workDir, session, options.scopeEntries));
          command = cmd;
          const result = await execAsync(cmd, {
            cwd: workDir,
            timeout: clampCommandTimeout(60_000, gateDeadlineAt),
          });
          output = result.stdout + result.stderr;
          passed = true;
          break;
        }

        case 'custom-script': {
          if (!check.command) {
            output = 'No command specified for custom-script check';
            break;
          }
          command = check.command;
          const result = await execAsync(check.command, {
            cwd: workDir,
            timeout: clampCommandTimeout(120_000, gateDeadlineAt),
          });
          output = result.stdout + result.stderr;
          passed = true;
          break;
        }

        case 'modified-test': {
          const modifiedTests = await findScopedModifiedTestFiles(
            workDir,
            session,
            options.scopeEntries,
          );
          passed = modifiedTests.length > 0;
          output = passed
            ? `Modified scoped test files: ${modifiedTests.join(', ')}`
            : 'No modified scoped test files found for the current work item scope';
          break;
        }

        case 'scenario-evidence': {
          const scenarioEvidence = await evaluateScenarioEvidence(
            workDir,
            session,
            options.stageOutput,
          );
          passed = scenarioEvidence.passed;
          output = scenarioEvidence.output;
          break;
        }

        case 'analysis-report-clear': {
          const stageOutput = options.stageOutput?.trim();
          if (!stageOutput) {
            output = 'No stage output available for analysis-report-clear check';
            break;
          }

          const structured = parseStructuredStageOutputResult(stageOutput, 'analysis-report');
          if (!structured.data) {
            output =
              structured.error.message ||
              'Stage output did not satisfy the structured analysis-report contract';
            break;
          }

          const findings = structured.data.findings ?? [];
          const decisions = structured.data.decisions ?? [];
          passed = findings.length === 0 && decisions.length === 0;
          output = passed
            ? 'Analysis report is clear: no blocking findings or unresolved decisions.'
            : [
                `Analysis report contains ${findings.length} blocking finding(s) and ${decisions.length} unresolved decision(s).`,
                findings.length > 0
                  ? `Findings: ${findings
                      .slice(0, 5)
                      .map((finding) => `[${finding.severity}] ${finding.title}`)
                      .join('; ')}`
                  : '',
                decisions.length > 0
                  ? `Decisions: ${decisions
                      .slice(0, 3)
                      .map((decision) => decision.question)
                      .join('; ')}`
                  : '',
              ]
                .filter(Boolean)
                .join('\n');
          break;
        }

        case 'replay-target-coverage': {
          const replayCoverage = await evaluateReplayTargetCoverage(workDir, session);
          passed = replayCoverage.passed;
          output = replayCoverage.output;
          break;
        }

        case 'model-review': {
          const review = await runModelReviewCheck(
            check,
            session,
            stageName,
            options,
            checkTimeoutMs,
          );
          passed = review.passed;
          output = review.feedback;
          timedOut = review.timedOut;
          modelReview = review.modelReview;
          break;
        }
      }
    } catch (err) {
      passed = false;
      output = formatCommandFailure(err);
      timedOut = isTimeoutFailure(output);
    }

    let distilledSummary: string | undefined;
    if (!passed && output) {
      const kind = distillKindFor(check.type);
      if (kind) {
        const result = distill(output, kind, { maxBytes: 4_000 });
        distilledSummary = result.summary;
      }
    }

    results.push({
      name: check.name,
      passed,
      command,
      output,
      distilledSummary,
      durationMs: Date.now() - checkStartTime,
      timedOut,
      timeoutMs: checkTimeoutMs ?? gateTimeoutMs,
      modelReview,
    });
  }

  const passedCount = results.filter((result) => result.passed).length;
  const totalChecks = results.length;
  const passRate = totalChecks > 0 ? passedCount / totalChecks : 1;
  const overallPassed = passRate >= gate.passThreshold;

  const feedback = results
    .filter((result) => !result.passed)
    .map((result) => {
      const summary = result.distilledSummary ?? result.output?.slice(0, 1_000);
      if (!summary) return `FAILED: ${result.name}\nNo output`;
      const sizeNote =
        result.distilledSummary && result.output && result.output.length > summary.length
          ? ` [distilled ${result.output.length}→${summary.length} bytes]`
          : '';
      return `FAILED: ${result.name}${sizeNote}\n${summary}`;
    })
    .join('\n\n');

  return {
    name: gate.name,
    passed: overallPassed,
    feedback: overallPassed ? 'All checks passed' : feedback,
    checks: results,
    durationMs: Date.now() - gateStartTime,
    timeoutMs: gateTimeoutMs,
    timedOut: results.some((result) => result.timedOut),
  };
}

async function evaluateScenarioEvidence(
  workDir: string,
  session: Session,
  stageOutput?: string,
): Promise<{ passed: boolean; output: string }> {
  const jiraKey = session.workItem.jiraKey?.trim();
  if (!jiraKey || !JIRA_KEY_PATTERN.test(jiraKey)) {
    return {
      passed: true,
      output:
        'No Jira ticket key is attached to this work item; scenario-evidence gate is not applicable.',
    };
  }

  const expectedSurfaces = classifyExpectedEvidenceSurfaces(session);
  const exactArtifacts = await resolveMentionedEvidenceArtifacts(workDir, stageOutput ?? '');
  const discoveredArtifacts = await discoverScenarioEvidenceArtifacts(workDir, jiraKey);
  const allArtifacts = [...new Set([...exactArtifacts, ...discoveredArtifacts])];
  const artifactSummary =
    allArtifacts.length > 0
      ? allArtifacts
          .slice(0, 25)
          .map((artifact) => `- ${artifact}`)
          .join('\n')
      : '- (none)';

  const missing: string[] = [];
  const normalizedOutput = stageOutput ?? '';

  if (!hasScenarioMapping(normalizedOutput, jiraKey)) {
    missing.push(
      'stage output must map Jira scenario -> root cause -> fix commit -> exact evidence artifact -> verification command -> residual risk',
    );
  }

  if (expectedSurfaces.has('ui')) {
    const uiArtifacts = allArtifacts.filter(isUiEvidenceArtifact);
    const hasStudioCommand = /\bpnpm\s+studio:video:evidence\b/.test(normalizedOutput);
    const hasScenarioSpecificText =
      normalizedOutput.includes(jiraKey) && /\bscenario\b/i.test(normalizedOutput);

    if (!hasStudioCommand) {
      missing.push('UI evidence must include the exact pnpm studio:video:evidence command');
    }
    if (!hasScenarioSpecificText) {
      missing.push('UI evidence must name the Jira-specific Studio scenario, not only page load');
    }
    if (uiArtifacts.length === 0) {
      missing.push(
        'UI evidence must include existing Studio video/screenshot artifacts under .codex-artifacts/studio-video-evidence',
      );
    }
  }

  if (expectedSurfaces.has('api-runtime')) {
    const apiArtifacts = allArtifacts.filter((artifact) => isApiRuntimeEvidenceArtifact(artifact));
    const hasResponseArtifact = apiArtifacts.some((artifact) => /response/i.test(artifact));
    const hasHeaderOrBodyArtifact = apiArtifacts.some((artifact) =>
      /\b(headers?|body)\b/i.test(artifact),
    );

    if (apiArtifacts.length === 0 || !hasResponseArtifact || !hasHeaderOrBodyArtifact) {
      missing.push(
        `API/runtime evidence must include response plus header/body artifacts under .codex-artifacts/helix-evidence/${jiraKey}`,
      );
    }
  }

  if (missing.length > 0) {
    return {
      passed: false,
      output: [
        `BLOCKED: Jira scenario-specific evidence is incomplete for ${jiraKey}.`,
        '',
        'Missing:',
        ...missing.map((entry) => `- ${entry}`),
        '',
        'Detected artifacts:',
        artifactSummary,
      ].join('\n'),
    };
  }

  return {
    passed: true,
    output: [
      `Scenario-mapped Jira evidence verified for ${jiraKey}.`,
      `Expected surfaces: ${[...expectedSurfaces].join(', ')}`,
      'Evidence artifacts:',
      artifactSummary,
    ].join('\n'),
  };
}

function classifyExpectedEvidenceSurfaces(session: Session): Set<'ui' | 'api-runtime'> {
  const text = [session.workItem.title, session.workItem.description, ...session.workItem.scope]
    .join(' ')
    .toLowerCase();

  const expected = new Set<'ui' | 'api-runtime'>();
  if (
    /\b(apps\/studio|studio|ui|ux|frontend|browser|screen|screenshot|video|modal|button|page|visual)\b/.test(
      text,
    )
  ) {
    expected.add('ui');
  }
  if (
    /\b(apps\/runtime|runtime|api|http|endpoint|route|header|body|websocket|sdk|response|server)\b/.test(
      text,
    )
  ) {
    expected.add('api-runtime');
  }

  if (expected.size === 0) {
    expected.add('api-runtime');
  }

  return expected;
}

function hasScenarioMapping(output: string, jiraKey: string): boolean {
  if (!output.trim()) return false;
  const requiredPatterns = [
    new RegExp(jiraKey.replace('-', '[-\\s]?'), 'i'),
    /jira\s+scenario/i,
    /root\s+cause/i,
    /fix\s+commit/i,
    /evidence\s+artifact/i,
    /verification\s+command/i,
    /residual\s+risk/i,
  ];
  return requiredPatterns.every((pattern) => pattern.test(output));
}

async function resolveMentionedEvidenceArtifacts(
  workDir: string,
  output: string,
): Promise<string[]> {
  const artifacts: string[] = [];
  for (const match of output.matchAll(ARTIFACT_PATH_PATTERN)) {
    const rawPath = match[1]?.replace(/[),.;\]]+$/g, '');
    if (!rawPath) continue;
    const absolutePath = resolve(workDir, rawPath);
    if (!isPathInside(workDir, absolutePath)) continue;
    try {
      await access(absolutePath);
      artifacts.push(relative(workDir, absolutePath));
    } catch {
      // A model mention is not evidence unless the artifact exists.
    }
  }
  return artifacts;
}

async function discoverScenarioEvidenceArtifacts(
  workDir: string,
  jiraKey: string,
): Promise<string[]> {
  const lowerJiraKey = jiraKey.toLowerCase();
  const roots = [
    join(workDir, '.codex-artifacts', 'studio-video-evidence'),
    join(workDir, '.codex-artifacts', 'helix-evidence', jiraKey),
    join(workDir, '.codex-artifacts', 'helix-evidence', lowerJiraKey),
    join(workDir, '.helix', 'evidence', jiraKey),
    join(workDir, '.helix', 'evidence', lowerJiraKey),
  ];

  const artifacts: string[] = [];
  for (const root of roots) {
    artifacts.push(...(await collectEvidenceFiles(workDir, root)));
    if (artifacts.length >= MAX_SCENARIO_EVIDENCE_ARTIFACTS) {
      break;
    }
  }

  return artifacts.slice(0, MAX_SCENARIO_EVIDENCE_ARTIFACTS);
}

async function collectEvidenceFiles(workDir: string, root: string): Promise<string[]> {
  try {
    await access(root);
  } catch {
    return [];
  }

  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < MAX_SCENARIO_EVIDENCE_ARTIFACTS) {
    const current = pending.pop();
    if (!current) continue;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (!isPathInside(workDir, absolutePath)) continue;
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile()) {
        files.push(relative(workDir, absolutePath));
        if (files.length >= MAX_SCENARIO_EVIDENCE_ARTIFACTS) break;
      }
    }
  }

  return files;
}

function isUiEvidenceArtifact(relativePath: string): boolean {
  return (
    relativePath.startsWith('.codex-artifacts/studio-video-evidence/') &&
    UI_EVIDENCE_EXTENSIONS.test(relativePath)
  );
}

function isApiRuntimeEvidenceArtifact(relativePath: string): boolean {
  return (
    (relativePath.startsWith('.codex-artifacts/helix-evidence/') ||
      relativePath.startsWith('.helix/evidence/')) &&
    API_EVIDENCE_EXTENSIONS.test(relativePath)
  );
}

function isPathInside(workDir: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(workDir), resolve(candidatePath));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

async function runModelReviewCheck(
  check: QualityCheck,
  session: Session,
  stageName: string,
  options: QualityGateExecutionOptions,
  timeoutMs?: number,
): Promise<{
  passed: boolean;
  feedback: string;
  timedOut: boolean;
  modelReview?: ModelReviewCheckSummary;
}> {
  if (!options.runModelReview) {
    return {
      passed: false,
      feedback: 'Model review executor is not configured for this quality gate',
      timedOut: false,
    };
  }

  const outputSchema = check.reviewOutputSchema ?? MODEL_REVIEW_OUTPUT_SCHEMA;
  const prompt =
    outputSchema.id === 'plan-review'
      ? buildPlanModelReviewPrompt({
          stageName,
          session,
          stageOutput: options.stageOutput,
          promptContext: options.promptContext,
          reviewInstructions: check.prompt,
        })
      : buildBlockingModelReviewPrompt({
          stageName,
          session,
          stageOutput: options.stageOutput,
          promptContext: options.promptContext,
          reviewInstructions: check.prompt,
        });

  const result = await options.runModelReview({
    check,
    prompt,
    outputSchema,
    timeoutMs,
  });

  if (outputSchema.id === 'plan-review') {
    const parsed = parseStructuredStageOutputResult(result.output, 'plan-review');
    if (result.error && !parsed.data) {
      return {
        passed: false,
        feedback: `Model review failed: ${result.error}`,
        timedOut: Boolean(result.timedOut),
      };
    }
    if (!parsed.data) {
      return {
        passed: false,
        feedback: parsed.error.message,
        timedOut: false,
      };
    }

    const unresolvedDecisions = parsed.data.decisions.filter(
      (decision) => decision.classification === 'AMBIGUOUS',
    );
    const planUnderReview = options.stageOutput
      ? parseStructuredStageOutput(options.stageOutput, 'slice-plan')
      : null;
    const expectedSliceNumbers = new Set(
      (planUnderReview?.slices ?? []).map((_, index) => index + 1),
    );
    const assessedSliceNumbers = new Set(
      parsed.data.sliceAssessments.map((assessment) => assessment.sliceNumber),
    );
    const missingAssessments = [...expectedSliceNumbers].filter(
      (sliceNumber) => !assessedSliceNumbers.has(sliceNumber),
    );

    const blockingFindings = parsed.data.findings.filter(
      (finding) => finding.disposition === 'blocking',
    );
    if (missingAssessments.length > 0) {
      blockingFindings.push({
        disposition: 'blocking',
        severity: 'high',
        category: 'inconsistency',
        title: 'Plan review omitted slice assessments',
        description: `The reviewer must classify every slice. Missing assessments for slices: ${missingAssessments.join(', ')}`,
        files: [],
      });
    }
    const advisoryFindings = parsed.data.findings.filter(
      (finding) => finding.disposition === 'advisory',
    );
    const hasSliceRevisions = parsed.data.sliceAssessments.some(
      (assessment) => assessment.verdict !== 'approved',
    );
    const modelReview: ModelReviewCheckSummary = {
      schemaId: 'plan-review',
      approved:
        blockingFindings.length === 0 && unresolvedDecisions.length === 0 && !hasSliceRevisions,
      blockingFindings,
      advisoryFindings,
      sliceAssessments: parsed.data.sliceAssessments,
      deferredFindings: parsed.data.deferredFindings,
      unresolvedDecisions,
      summary: parsed.data.summary,
    };

    return {
      passed: modelReview.approved,
      feedback: formatPlanReviewFeedback(parsed.data, unresolvedDecisions, result.model),
      timedOut: false,
      modelReview,
    };
  }

  const parsed = parseStructuredStageOutputResult(result.output, 'analysis-report');
  if (result.error && !parsed.data) {
    return {
      passed: false,
      feedback: `Model review failed: ${result.error}`,
      timedOut: Boolean(result.timedOut),
    };
  }
  if (!parsed.data) {
    return {
      passed: false,
      feedback: parsed.error.message,
      timedOut: false,
    };
  }

  const unresolvedDecisions = parsed.data.decisions.filter(
    (decision) => decision.classification === 'AMBIGUOUS',
  );
  const modelReview: ModelReviewCheckSummary = {
    schemaId: 'analysis-report',
    approved: parsed.data.findings.length === 0 && unresolvedDecisions.length === 0,
    findings: parsed.data.findings,
    unresolvedDecisions,
    summary: parsed.data.summary,
  };

  return {
    passed: modelReview.approved,
    feedback: formatModelReviewFeedback(parsed.data, unresolvedDecisions, result.model),
    timedOut: false,
    modelReview,
  };
}

/**
 * Build the in-scope file set for the typecheck-scope filter (slice 23).
 *
 * Combines workItem.scope with the current slice's fileContracts when
 * options.scopeEntries hasn't already pinned a tighter set. The
 * resulting list is what the typecheck-scope-filter checks each parsed
 * tsc error against — only errors whose files fall inside this set
 * fail the gate; errors outside it are pre-existing and advisory.
 */
function collectInScopeFiles(session: Session, options: QualityGateExecutionOptions): string[] {
  const result = new Set<string>();
  const explicitScope = options.scopeEntries ?? [];
  for (const entry of explicitScope) {
    const trimmed = entry.trim();
    if (trimmed) result.add(trimmed);
  }
  if (result.size === 0) {
    for (const entry of session.workItem.scope) {
      const trimmed = entry.trim();
      if (trimmed) result.add(trimmed);
    }
  }
  const activeSlice =
    session.currentSliceIndex != null ? session.slices?.[session.currentSliceIndex] : undefined;
  if (activeSlice?.manifest?.fileContracts) {
    for (const contract of activeSlice.manifest.fileContracts) {
      const trimmed = contract.path?.trim();
      if (trimmed) result.add(trimmed);
    }
  }
  return [...result];
}

function distillKindFor(checkType: QualityCheck['type']): DistillKind | undefined {
  switch (checkType) {
    case 'typecheck':
      return 'typecheck';
    case 'test':
      return 'test';
    case 'lint':
      return 'lint';
    case 'custom-script':
      return 'generic';
    default:
      return undefined;
  }
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

function clampCommandTimeout(defaultTimeoutMs: number, deadlineAt?: number): number {
  const remainingTimeoutMs = getRemainingTimeoutMs(deadlineAt);
  if (remainingTimeoutMs == null) {
    return defaultTimeoutMs;
  }
  return Math.max(1, Math.min(defaultTimeoutMs, remainingTimeoutMs));
}

function isTimeoutFailure(message: string): boolean {
  return /\btimed out\b/i.test(message) || /\bdeadline\b/i.test(message);
}

function formatCommandFailure(error: unknown): string {
  if (error instanceof Error && 'stdout' in error) {
    const execErr = error as Error & { stdout?: string; stderr?: string };
    return (execErr.stdout ?? '') + (execErr.stderr ?? '');
  }
  return error instanceof Error ? error.message : String(error);
}

function formatModelReviewFeedback(
  review: AnalysisStageOutput,
  unresolvedDecisions: AnalysisStageOutput['decisions'],
  reviewer: string,
): string {
  const lines = [`Reviewer (${reviewer}): ${review.summary || 'No summary provided.'}`];

  if (review.findings.length > 0) {
    lines.push('', 'Blocking findings:');
    for (const finding of review.findings) {
      const files = finding.files.length > 0 ? ` | files: ${finding.files.join(', ')}` : '';
      const description =
        finding.description && finding.description !== finding.title
          ? ` — ${finding.description}`
          : '';
      lines.push(
        `- [${finding.severity}] [${finding.category}] ${finding.title}${description}${files}`,
      );
    }
  }

  if (unresolvedDecisions.length > 0) {
    lines.push('', 'Unresolved decisions:');
    for (const decision of unresolvedDecisions) {
      lines.push(`- ${decision.question}`);
    }
  }

  if (review.findings.length === 0 && unresolvedDecisions.length === 0) {
    lines.push('', 'No blocking findings.');
  }

  return lines.join('\n');
}

function formatPlanReviewFeedback(
  review: PlanReviewStageOutput,
  unresolvedDecisions: PlanReviewStageOutput['decisions'],
  reviewer: string,
): string {
  const lines = [`Reviewer (${reviewer}): ${review.summary || 'No summary provided.'}`];

  const approvedSlices = review.sliceAssessments.filter(
    (assessment) => assessment.verdict === 'approved',
  );
  const revisedSlices = review.sliceAssessments.filter(
    (assessment) => assessment.verdict === 'revise',
  );
  const blockingFindings = review.findings.filter((finding) => finding.disposition === 'blocking');
  const advisoryFindings = review.findings.filter((finding) => finding.disposition === 'advisory');

  if (approvedSlices.length > 0) {
    lines.push(
      '',
      `Approved slices: ${approvedSlices.map((assessment) => assessment.sliceNumber).join(', ')}`,
    );
  }

  if (revisedSlices.length > 0) {
    lines.push('', 'Slices to revise:');
    for (const slice of revisedSlices) {
      lines.push(`- Slice ${slice.sliceNumber}: ${slice.rationale}`);
      if (slice.requiredTestAmendments.length > 0) {
        lines.push(`  Required test amendments: ${slice.requiredTestAmendments.join(' | ')}`);
      }
    }
  }

  if (review.deferredFindings.length > 0) {
    lines.push('', 'Deferred backlog findings:');
    for (const finding of review.deferredFindings) {
      lines.push(`- ${finding.findingId}: ${finding.reason}`);
    }
  }

  if (blockingFindings.length > 0) {
    lines.push('', 'Blocking findings:');
    for (const finding of blockingFindings) {
      const files = finding.files.length > 0 ? ` | files: ${finding.files.join(', ')}` : '';
      lines.push(
        `- [${finding.severity}] [${finding.category}] ${finding.title} - ${finding.description}${files}`,
      );
    }
  }

  if (advisoryFindings.length > 0) {
    lines.push('', 'Advisory findings:');
    for (const finding of advisoryFindings) {
      const files = finding.files.length > 0 ? ` | files: ${finding.files.join(', ')}` : '';
      lines.push(
        `- [${finding.severity}] [${finding.category}] ${finding.title} - ${finding.description}${files}`,
      );
    }
  }

  if (unresolvedDecisions.length > 0) {
    lines.push('', 'Unresolved decisions:');
    for (const decision of unresolvedDecisions) {
      lines.push(`- ${decision.question}`);
    }
  }

  if (
    approvedSlices.length === review.sliceAssessments.length &&
    blockingFindings.length === 0 &&
    unresolvedDecisions.length === 0
  ) {
    lines.push('', 'All slices approved with no blocking findings.');
  }

  return lines.join('\n');
}

async function findScopedModifiedTestFiles(
  workDir: string,
  session: Session,
  scopeEntries?: string[],
): Promise<string[]> {
  const scope = resolveGateScopeEntries(session, scopeEntries);
  const explicitTestTargets = dedupe(scope.filter(isTestFilePath));
  const scopeTargets =
    explicitTestTargets.length > 0
      ? explicitTestTargets
      : dedupe(scope.map(scopeEntryToWorkspaceTarget));

  if (scopeTargets.length === 0) {
    return [];
  }

  return (await findModifiedWorkspacePaths(workDir, scopeTargets)).filter(isTestFilePath);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

// Max number of packages/files to include in scoped commands
const MAX_SCOPED_PACKAGES = 10;
const MAX_SCOPED_FILES = 50;
const MAX_SCOPED_TYPECHECK_FILES = 200;
const SCOPED_TYPECHECK_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.d.ts',
  '.d.mts',
  '.d.cts',
];

interface ScopedPackageTarget {
  packageDir: string;
  fileEntries: string[];
}

/**
 * Resolve session scope entries to pnpm workspace package names.
 *
 * Scope entries look like "packages/web-sdk/src" or "apps/runtime/src/websocket".
 * We walk up to the nearest package.json and read its `name` field.
 */
async function resolveAffectedPackageNames(
  workDir: string,
  session: Session,
  scopeEntries?: string[],
): Promise<string[]> {
  // Use session scope if available, otherwise derive from git diff
  let entries = resolveGateScopeEntries(session, scopeEntries);
  if (entries.length === 0) {
    entries = await getModifiedPackageDirsFromGit(workDir);
  }
  if (entries.length === 0) return [];

  const packageDirs = new Set<string>();
  for (const entry of entries) {
    const parts = entry.split('/');
    if (parts.length >= 2) {
      packageDirs.add(parts.slice(0, 2).join('/'));
    }
  }

  const names: string[] = [];
  for (const dir of [...packageDirs].slice(0, MAX_SCOPED_PACKAGES)) {
    try {
      const pkgPath = join(workDir, dir, 'package.json');
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      if (pkg.name) names.push(pkg.name);
    } catch {
      // Not a package directory, skip
    }
  }

  return dedupe(names);
}

export async function buildScopedTypecheckCmd(
  workDir: string,
  session: Session,
  scopeEntries?: string[],
): Promise<string> {
  const scopedPackages = await resolveScopedPackageTargets(workDir, session, scopeEntries);
  if (scopedPackages.length > 0) {
    const commands = await Promise.all(
      scopedPackages.map(async ({ packageDir, fileEntries }) => {
        return buildScopedPackageTypecheckCmd(workDir, packageDir, fileEntries, session.id);
      }),
    );
    return commands.join(' && ');
  }

  const pkgs = await resolveAffectedPackageNames(workDir, session, scopeEntries);
  if (pkgs.length === 0) return 'npx tsc --noEmit';

  const filters = pkgs.map((p) => `--filter=${p}`).join(' ');
  return `pnpm ${filters} exec tsc --noEmit`;
}

async function shouldUsePackageBuildForScopedTypecheck(
  workDir: string,
  packageDir: string,
  fileEntries: string[],
): Promise<boolean> {
  if (fileEntries.every(isTestFilePath)) {
    return false;
  }

  const [pkg, tsconfig] = await Promise.all([
    readJsonFile<{ scripts?: Record<string, string> }>(join(workDir, packageDir, 'package.json')),
    readJsonFile<{
      compilerOptions?: { composite?: boolean; rootDir?: string };
      references?: unknown[];
    }>(join(workDir, packageDir, 'tsconfig.json')),
  ]);

  const buildScript = pkg?.scripts?.build?.trim();
  if (!buildScript || !tsconfig) {
    return false;
  }

  if (isHeavyBuildScript(buildScript)) {
    return false;
  }

  return (
    (Array.isArray(tsconfig.references) && tsconfig.references.length > 0) ||
    tsconfig.compilerOptions?.composite === true ||
    typeof tsconfig.compilerOptions?.rootDir === 'string'
  );
}

function isHeavyBuildScript(buildScript: string): boolean {
  return /\b(?:next|nuxt|react-scripts)\s+build\b|\bvite\s+build\b|\bwebpack\b|\bturbo\b|\bensure:web-sdk\b/i.test(
    buildScript,
  );
}

export async function buildScopedTestCmd(
  workDir: string,
  session: Session,
  scopeEntries?: string[],
): Promise<string> {
  const scope = resolveGateScopeEntries(session, scopeEntries);
  const explicitTestTargets = dedupe(scope.filter(isTestFilePath));
  if (explicitTestTargets.length > 0) {
    return buildExplicitScopedTestCmd(workDir, explicitTestTargets);
  }

  const modifiedScopedTestTargets = await findScopedModifiedTestFiles(
    workDir,
    session,
    scopeEntries,
  );
  if (modifiedScopedTestTargets.length > 0) {
    return buildExplicitScopedTestCmd(workDir, modifiedScopedTestTargets);
  }

  const pkgs = await resolveAffectedPackageNames(workDir, session, scopeEntries);
  if (pkgs.length === 0) return 'pnpm test:report:fast';

  const filters = pkgs.map((p) => `--filter=${p}`).join(' ');
  return `pnpm ${filters} run test`;
}

export async function buildSliceVerificationCommandPacket(
  workDir: string,
  session: Session,
  options: {
    typecheckScopeEntries?: string[];
    formatScopeEntries?: string[];
    requiredTestFiles?: string[];
    regressionTestFiles?: string[];
  },
): Promise<SliceVerificationCommandPacket> {
  const formatScopeEntries = await filterExistingWorkspaceFiles(
    workDir,
    options.formatScopeEntries ?? [],
  );
  const requiredTestFiles = await filterExistingWorkspaceFiles(
    workDir,
    options.requiredTestFiles ?? [],
  );
  const regressionTestFiles = await filterExistingWorkspaceFiles(
    workDir,
    options.regressionTestFiles ?? [],
  );
  const buildOrTypecheckCommand = await buildScopedTypecheckCmd(
    workDir,
    session,
    options.typecheckScopeEntries,
  );
  const formatCommand = buildExplicitPrettierCheckCmd(formatScopeEntries);
  const requiredTestCommand =
    requiredTestFiles.length > 0
      ? await buildExplicitScopedTestCmd(workDir, requiredTestFiles)
      : undefined;
  const regressionCommand =
    regressionTestFiles.length > 0
      ? await buildExplicitScopedTestCmd(workDir, regressionTestFiles)
      : undefined;
  const combinedTestLockCommand = await buildTestLockCommand(workDir, [
    ...requiredTestFiles,
    ...regressionTestFiles,
  ]);

  return {
    buildOrTypecheckCommand,
    formatCommand,
    requiredTestCommand,
    regressionCommand,
    combinedTestLockCommand,
  };
}

async function buildFocusedVitestFallbackCmd(
  workDir: string,
  session: Session,
  scopeEntries?: string[],
): Promise<string | null> {
  const scope = resolveGateScopeEntries(session, scopeEntries);
  const explicitTestTargets = dedupe(scope.filter(isTestFilePath));
  if (explicitTestTargets.length === 0) {
    return null;
  }

  const byPackage = new Map<string, { files: Set<string>; titles: Set<string> }>();

  for (const file of explicitTestTargets.slice(0, MAX_SCOPED_FILES)) {
    const match = file.match(/^((?:packages|apps)\/[^/]+)\//);
    if (!match) continue;

    const pkgDir = match[1];
    if (!(await packageUsesVitest(workDir, pkgDir))) {
      continue;
    }

    const titles = await findAddedTestTitles(workDir, file);
    if (titles.length === 0) {
      continue;
    }

    const relativeFile = file.slice(pkgDir.length + 1);
    const group = byPackage.get(pkgDir) ?? { files: new Set<string>(), titles: new Set<string>() };
    group.files.add(relativeFile);
    for (const title of titles) {
      group.titles.add(title);
    }
    byPackage.set(pkgDir, group);
  }

  if (byPackage.size === 0) {
    return null;
  }

  const commands = [...byPackage.entries()].map(async ([pkgDir, group]) => {
    const titlePattern = [...group.titles].map(escapeRegExp).join('|');
    return buildScopedVitestExecCommands(
      workDir,
      pkgDir,
      [...group.files],
      `-t ${quoteShellArg(titlePattern)}`,
    );
  });

  return (await Promise.all(commands)).flat().join(' && ');
}

export async function buildExplicitScopedTestCmd(
  workDir: string,
  testFiles: string[],
): Promise<string> {
  const byPackage = new Map<string, Set<string>>();
  const uniqueTestFiles = dedupe(testFiles).filter(isRunnableProofTestFile);

  for (const file of uniqueTestFiles.slice(0, MAX_SCOPED_FILES)) {
    const match = file.match(/^((?:packages|apps)\/[^/]+)\//);
    if (!match) continue;

    const pkgDir = match[1];
    const relativeFile = file.slice(pkgDir.length + 1);
    const group = byPackage.get(pkgDir) ?? new Set<string>();
    group.add(relativeFile);
    byPackage.set(pkgDir, group);
  }

  if (byPackage.size === 0) {
    const quotedFiles = uniqueTestFiles.slice(0, MAX_SCOPED_FILES).map(quoteShellArg).join(' ');
    return `pnpm vitest run ${quotedFiles} --reporter=verbose`;
  }

  const commands = await Promise.all(
    [...byPackage.entries()].map(async ([pkgDir, files]) => {
      if (await packageUsesVitest(workDir, pkgDir)) {
        return buildScopedVitestExecCommands(workDir, pkgDir, [...files]);
      }
      const quotedFiles = [...files].map(quoteShellArg).join(' ');
      return [`pnpm --filter ./${pkgDir} test -- ${quotedFiles}`];
    }),
  );

  return commands.flat().join(' && ');
}

export async function buildTestLockCommand(workDir: string, testFiles: string[]): Promise<string> {
  const uniqueTestFiles = dedupe(testFiles);
  if (uniqueTestFiles.length === 0) {
    return '';
  }

  return buildExplicitScopedTestCmd(workDir, uniqueTestFiles);
}

async function packageUsesVitest(workDir: string, pkgDir: string): Promise<boolean> {
  try {
    const packageJsonPath = join(workDir, pkgDir, 'package.json');
    const pkg = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const scriptUsesVitest = Object.values(pkg.scripts ?? {}).some((script) =>
      /\bvitest\b/.test(script),
    );
    return Boolean(
      scriptUsesVitest ||
      pkg.dependencies?.vitest ||
      pkg.devDependencies?.vitest ||
      pkg.dependencies?.['@vitest/coverage-v8'] ||
      pkg.devDependencies?.['@vitest/coverage-v8'],
    );
  } catch {
    return false;
  }
}

async function buildScopedVitestExecCommands(
  workDir: string,
  pkgDir: string,
  relativeFiles: string[],
  trailingArgs = '',
): Promise<string[]> {
  if (relativeFiles.length === 0) {
    return [];
  }

  const nodeConfigPath = join(workDir, pkgDir, 'vitest.node.config.ts');
  const nodeConfigAvailable = await pathExists(nodeConfigPath);
  const groups = nodeConfigAvailable
    ? [
        {
          configArg: '--config vitest.node.config.ts',
          files: relativeFiles.filter(isNodeVitestTestFile),
        },
        {
          configArg: '',
          files: relativeFiles.filter((file) => !isNodeVitestTestFile(file)),
        },
      ]
    : [{ configArg: '', files: relativeFiles }];

  return groups
    .filter((group) => group.files.length > 0)
    .map((group) =>
      [
        `pnpm --filter ./${pkgDir} exec vitest run`,
        group.configArg,
        group.files.map(quoteShellArg).join(' '),
        trailingArgs.trim(),
      ]
        .filter(Boolean)
        .join(' '),
    );
}

function isNodeVitestTestFile(relativeFile: string): boolean {
  const normalized = relativeFile.replaceAll('\\', '/');
  return normalized.startsWith('src/__tests__/api-routes/') || normalized.endsWith('.e2e.test.ts');
}

function isRunnableProofTestFile(file: string): boolean {
  if (!isTestFilePath(file)) {
    return false;
  }

  const normalized = file.replaceAll('\\', '/');
  return !normalized.includes('/__tests__/helpers/');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findAddedTestTitles(workDir: string, file: string): Promise<string[]> {
  const diffCommands = [
    `git diff --unified=0 -- ${quoteShellArg(file)}`,
    `git diff --cached --unified=0 -- ${quoteShellArg(file)}`,
    `git diff HEAD~1 --unified=0 -- ${quoteShellArg(file)}`,
  ];

  for (const command of diffCommands) {
    try {
      const result = await execAsync(command, {
        cwd: workDir,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const titles = extractAddedTestTitles(result.stdout + result.stderr);
      if (titles.length > 0) {
        return titles;
      }
    } catch (err) {
      const output = formatCommandFailure(err);
      const titles = extractAddedTestTitles(output);
      if (titles.length > 0) {
        return titles;
      }
    }
  }

  return [];
}

function extractAddedTestTitles(diffText: string): string[] {
  const titles = new Set<string>();
  const testDeclaration =
    /^\+\s*(?:it|test)(?:\.(?:only|skip|todo|concurrent))?(?:\.each\([^)]*\))?\(\s*(['"`])(.+?)\1/;

  for (const line of diffText.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }

    const match = line.match(testDeclaration);
    const title = match?.[2]?.trim();
    if (title) {
      titles.add(title);
    }
  }

  return [...titles];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function maybeAllowReplayBaselineTestFailure(
  workDir: string,
  session: Session,
  scopeEntries: string[] | undefined,
  output: string,
): string | null {
  if ((session.replayContext?.changedFiles?.length ?? 0) === 0) {
    return null;
  }

  if (
    !/\b(Failed to resolve import|ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath .* is not defined by "exports"|Cannot find module)\b/i.test(
      output,
    )
  ) {
    return null;
  }

  const referencedFiles = extractReplayBaselineFailureFiles(workDir, output);
  if (referencedFiles.length === 0) {
    return null;
  }

  const inScopeFiles = new Set(
    resolveGateScopeEntries(session, scopeEntries)
      .filter(isScopeFilePath)
      .map((entry) => normalize(entry)),
  );
  const replayChangedFiles = new Set(
    (session.replayContext?.changedFiles ?? [])
      .filter(isScopeFilePath)
      .map((entry) => normalize(entry)),
  );

  if (referencedFiles.some((file) => inScopeFiles.has(file) || replayChangedFiles.has(file))) {
    return null;
  }

  return [
    'Replay verification baseline allowance:',
    `the failing import/module-resolution diagnostics point only at untouched workspace files outside the current replay seam (${referencedFiles.join(', ')}).`,
    'HELIX is treating this as non-blocking baseline noise for the historical replay so the slice can continue from its scoped proof results.',
  ].join(' ');
}

function extractReplayBaselineFailureFiles(workDir: string, output: string): string[] {
  const files = new Set<string>();
  const patterns = [
    /File:\s+([^\n:]+):\d+:\d+/g,
    /\bat\s+((?:\/|[A-Za-z]:\\)[^:\n]+\.[cm]?[jt]sx?):\d+:\d+/g,
  ];

  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const rawPath = match[1]?.trim();
      if (!rawPath) {
        continue;
      }

      const relativePath = normalize(relative(workDir, normalize(rawPath)));
      if (!relativePath || relativePath.startsWith('..')) {
        continue;
      }

      files.add(relativePath);
    }
  }

  return [...files];
}

export async function buildScopedLintCmd(
  workDir: string,
  session: Session,
  scopeEntries?: string[],
): Promise<string> {
  const scope = resolveGateScopeEntries(session, scopeEntries);
  const explicitFileTargets = dedupe(scope.filter(isScopeFilePath));
  const targets =
    explicitFileTargets.length > 0
      ? explicitFileTargets
      : dedupe(scope.map(scopeEntryToWorkspaceTarget));

  let modifiedFiles: string[];
  if (targets.length === 0) {
    // No scope — use git diff to find modified files
    modifiedFiles = await getModifiedPackageDirsFromGit(workDir);
  } else {
    modifiedFiles = await findModifiedWorkspacePaths(workDir, targets);
  }
  const existingFiles = await filterExistingWorkspaceFiles(workDir, modifiedFiles);
  const tsFiles = existingFiles.filter((f) => /\.[cm]?[jt]sx?$/.test(f)).slice(0, MAX_SCOPED_FILES);
  if (tsFiles.length === 0) return 'echo "No modified files to lint"';

  const quoted = tsFiles.map((f) => `"${f}"`).join(' ');
  return `npx prettier --check --ignore-unknown ${quoted}`;
}

export function buildExplicitPrettierCheckCmd(files: string[]): string {
  const uniqueFiles = dedupe(files.filter(isScopeFilePath)).slice(0, MAX_SCOPED_FILES);
  if (uniqueFiles.length === 0) {
    return 'echo "No slice files declared for prettier check"';
  }

  const quoted = uniqueFiles.map(quoteShellArg).join(' ');
  return `npx prettier --check --ignore-unknown ${quoted}`;
}

/**
 * When session scope is empty, derive affected directories from git status.
 * Returns paths like "packages/web-sdk/src/core/types.ts" from uncommitted changes.
 */
async function getModifiedPackageDirsFromGit(workDir: string): Promise<string[]> {
  try {
    const result = await execAsync('git diff --name-only HEAD', {
      cwd: workDir,
      timeout: 10_000,
    });
    const files = result.stdout
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    return files.slice(0, MAX_SCOPED_FILES);
  } catch {
    return [];
  }
}

function resolveGateScopeEntries(session: Session, scopeEntries?: string[]): string[] {
  return dedupe(
    (scopeEntries?.length ? scopeEntries : session.workItem.scope).map((entry) => entry.trim()),
  );
}

async function evaluateReplayTargetCoverage(
  workDir: string,
  session: Session,
): Promise<{ passed: boolean; output: string }> {
  const expectedFiles = dedupe(
    (session.replayContext?.changedFiles ?? [])
      .filter(isScopeFilePath)
      .map((entry) => normalize(entry)),
  );
  if (expectedFiles.length === 0) {
    return {
      passed: true,
      output: 'No replay target seam obligations declared for this session.',
    };
  }

  const baseRef = session.workspaceContext?.baseHeadSha ?? session.workspaceBaseline?.headSha;
  if (!baseRef) {
    return {
      passed: false,
      output:
        'Replay target seam coverage requires a captured replay base ref, but the session has neither workspaceContext.baseHeadSha nor workspaceBaseline.headSha.',
    };
  }

  let diffOutput = '';
  try {
    const result = await execAsync(`git diff --name-only ${quoteShellArg(baseRef)}`, {
      cwd: workDir,
      timeout: 15_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    diffOutput = result.stdout;
  } catch (error) {
    return {
      passed: false,
      output: `Unable to evaluate replay target seam coverage against ${baseRef}: ${formatCommandFailure(error)}`,
    };
  }

  const actualFiles = dedupe(
    diffOutput
      .split('\n')
      .map((entry) => entry.trim())
      .filter(isScopeFilePath)
      .map((entry) => normalize(entry)),
  );
  const actualFileSet = new Set(actualFiles);
  const missingFiles = expectedFiles.filter((filePath) => !actualFileSet.has(filePath));

  if (missingFiles.length === 0) {
    return {
      passed: true,
      output: [
        `Replay target seam coverage passed against ${baseRef}.`,
        `Target seams satisfied: ${expectedFiles.join(', ')}`,
      ].join('\n'),
    };
  }

  return {
    passed: false,
    output: [
      `Replay target seam coverage failed against ${baseRef}.`,
      `Missing historical target files: ${missingFiles.join(', ')}`,
      `Actual replay-changed files: ${actualFiles.length > 0 ? actualFiles.join(', ') : '(none)'}`,
      'A replay is not successful until every declared target seam is either changed directly or HELIX records an explicit equivalence proof.',
    ].join('\n'),
  };
}

async function recoverScopedTypecheckFailure(
  workDir: string,
  session: Session,
  scopeEntries: string[] | undefined,
  gateDeadlineAt: number | undefined,
  initialFailureOutput?: string,
): Promise<ScopedTypecheckRecoveryResult | null> {
  const scopedPackages = await resolveScopedPackageTargets(workDir, session, scopeEntries);
  const packagesWithExplicitFiles = scopedPackages.filter(
    ({ fileEntries }) => fileEntries.length > 0,
  );
  if (packagesWithExplicitFiles.length === 0) {
    return null;
  }

  const recoveryNotes: string[] = [];
  let allPassed = true;

  for (const { packageDir, fileEntries } of packagesWithExplicitFiles) {
    const scopedSourceEntries = fileEntries.filter((entry) => !isTestFilePath(entry));
    if (scopedSourceEntries.length === 0) {
      recoveryNotes.push(
        `Scoped typecheck fallback skipped ./${packageDir} because only test files are in scope.`,
      );
      continue;
    }

    const refreshedScopedCommand = await maybeBuildRefreshedScopedTypecheckCommand(
      workDir,
      packageDir,
      fileEntries,
      session.id,
      initialFailureOutput ?? '',
    );
    if (refreshedScopedCommand) {
      try {
        const refreshedResult = await execAsync(refreshedScopedCommand, {
          cwd: workDir,
          timeout: clampCommandTimeout(120_000, gateDeadlineAt),
          maxBuffer: 10 * 1024 * 1024,
        });
        recoveryNotes.push(
          [
            `Scoped typecheck refresh passed via: ${refreshedScopedCommand}`,
            `Scoped source files: ${scopedSourceEntries.join(', ')}`,
            (refreshedResult.stdout + refreshedResult.stderr).trim(),
          ]
            .filter(Boolean)
            .join('\n'),
        );
        continue;
      } catch (refreshedErr) {
        const refreshedOutput = formatCommandFailure(refreshedErr);
        if (isTimeoutFailure(refreshedOutput)) {
          return {
            passed: false,
            output: refreshedOutput,
            timedOut: true,
          };
        }

        const packageFailureContext = [
          initialFailureOutput ?? '',
          `Scoped typecheck refresh failed via: ${refreshedScopedCommand}`,
          refreshedOutput,
        ]
          .filter(Boolean)
          .join('\n\n');
        initialFailureOutput = packageFailureContext;
      }
    }

    const packageCmd = `pnpm --filter ./${packageDir} exec tsc --noEmit`;
    try {
      const result = await execAsync(packageCmd, {
        cwd: workDir,
        timeout: clampCommandTimeout(120_000, gateDeadlineAt),
        maxBuffer: 10 * 1024 * 1024,
      });
      recoveryNotes.push(
        [
          `Scoped typecheck fallback passed via: ${packageCmd}`,
          `Scoped source files: ${scopedSourceEntries.join(', ')}`,
          (result.stdout + result.stderr).trim(),
        ]
          .filter(Boolean)
          .join('\n'),
      );
      continue;
    } catch (err) {
      let rawOutput = formatCommandFailure(err);
      if (initialFailureOutput) {
        rawOutput = [initialFailureOutput, rawOutput].filter(Boolean).join('\n\n');
      }
      if (isTimeoutFailure(rawOutput)) {
        return {
          passed: false,
          output: rawOutput,
          timedOut: true,
        };
      }

      const parsedDiagnostics = parseTypeScriptDiagnostics(rawOutput, join(workDir, packageDir));
      if (parsedDiagnostics.length === 0) {
        allPassed = false;
        recoveryNotes.push(rawOutput);
        continue;
      }

      const scopedDiagnostics = parsedDiagnostics.filter((diagnostic) =>
        scopedSourceEntries.some(
          (entry) => diagnostic.filePath === normalize(join(workDir, entry)),
        ),
      );

      if (scopedDiagnostics.length === 0) {
        recoveryNotes.push(
          [
            `Scoped typecheck fallback ignored out-of-scope diagnostics for ./${packageDir}.`,
            `Scoped source files: ${scopedSourceEntries.join(', ')}`,
          ].join('\n'),
        );
        continue;
      }

      allPassed = false;
      recoveryNotes.push(scopedDiagnostics.map((diagnostic) => diagnostic.text).join('\n\n'));
    }
  }

  if (recoveryNotes.length === 0) {
    return null;
  }

  return {
    passed: allPassed,
    output: recoveryNotes.join('\n\n'),
    timedOut: false,
  };
}

async function resolveScopedPackageTargets(
  workDir: string,
  session: Session,
  scopeEntries?: string[],
): Promise<ScopedPackageTarget[]> {
  const entries = resolveGateScopeEntries(session, scopeEntries);
  if (entries.length === 0) {
    return [];
  }

  const byPackage = new Map<string, Set<string>>();

  for (const entry of entries) {
    const packageDir = resolveWorkspacePackageDir(entry);
    if (!packageDir) {
      continue;
    }

    if (!(await pathExists(join(workDir, packageDir, 'package.json')))) {
      continue;
    }

    const fileEntries = byPackage.get(packageDir) ?? new Set<string>();
    if (isScopeFilePath(entry)) {
      fileEntries.add(entry);
    }
    byPackage.set(packageDir, fileEntries);
  }

  const scopedPackages: ScopedPackageTarget[] = [];
  for (const [packageDir, fileEntries] of [...byPackage.entries()].slice(0, MAX_SCOPED_PACKAGES)) {
    scopedPackages.push({
      packageDir,
      fileEntries: await filterExistingWorkspaceFiles(
        workDir,
        [...fileEntries].slice(0, MAX_SCOPED_FILES),
      ),
    });
  }

  return scopedPackages;
}

async function writeScopedTypecheckConfig(
  workDir: string,
  packageDir: string,
  fileEntries: string[],
  sessionId: string,
): Promise<string> {
  const relativeFiles = await expandScopedTypecheckFileSet(workDir, packageDir, fileEntries);
  await removeScopedTypecheckConfigs(workDir, packageDir, sessionId);

  const scopeHash = createHash('sha1').update(relativeFiles.join('\n')).digest('hex').slice(0, 12);
  const configPath = join(workDir, packageDir, `.helix-typecheck-${sessionId}-${scopeHash}.json`);
  const config = {
    extends: './tsconfig.json',
    include: [],
    exclude: ['.next', 'dist', 'build', 'coverage', 'node_modules'],
    files: relativeFiles,
  };

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return configPath;
}

async function expandScopedTypecheckFileSet(
  workDir: string,
  packageDir: string,
  fileEntries: string[],
): Promise<string[]> {
  const seeds = fileEntries
    .filter((entry) => entry.startsWith(`${packageDir}/`))
    .map((entry) => entry.slice(packageDir.length + 1))
    .filter(Boolean)
    .slice(0, MAX_SCOPED_FILES);

  const visited = new Set<string>(seeds);
  const queue = [...seeds];

  while (queue.length > 0 && visited.size < MAX_SCOPED_TYPECHECK_FILES) {
    const relativeFile = queue.shift();
    if (!relativeFile) {
      continue;
    }

    const filePath = join(workDir, packageDir, relativeFile);
    const content = await safeReadText(filePath);
    if (!content) {
      continue;
    }

    const currentDir = dirname(relativeFile);
    for (const specifier of parseRelativeImportSpecifiers(content)) {
      const resolved = await resolveScopedImportSpecifier(
        workDir,
        packageDir,
        currentDir,
        specifier,
      );
      if (!resolved || visited.has(resolved)) {
        continue;
      }

      visited.add(resolved);
      queue.push(resolved);
      if (visited.size >= MAX_SCOPED_TYPECHECK_FILES) {
        break;
      }
    }
  }

  return [...visited].sort((left, right) => left.localeCompare(right));
}

async function buildScopedPackageTypecheckCmd(
  workDir: string,
  packageDir: string,
  fileEntries: string[],
  sessionId: string,
): Promise<string> {
  const existingFileEntries = await filterExistingWorkspaceFiles(workDir, fileEntries);
  if (
    existingFileEntries.length === 0 ||
    !(await pathExists(join(workDir, packageDir, 'tsconfig.json')))
  ) {
    return `pnpm --filter ./${packageDir} exec tsc --noEmit`;
  }

  if (await shouldUsePackageBuildForScopedTypecheck(workDir, packageDir, existingFileEntries)) {
    return `pnpm --filter ./${packageDir} build`;
  }

  const typecheckConfigPath = await writeScopedTypecheckConfig(
    workDir,
    packageDir,
    existingFileEntries,
    sessionId,
  );
  const packageWorkDir = join(workDir, packageDir);
  const relativeConfigPath = normalize(relative(packageWorkDir, typecheckConfigPath));
  return `pnpm --filter ./${packageDir} exec tsc --noEmit -p ${quoteShellArg(relativeConfigPath)}`;
}

async function maybeBuildRefreshedScopedTypecheckCommand(
  workDir: string,
  packageDir: string,
  fileEntries: string[],
  sessionId: string,
  rawOutput: string,
): Promise<string | null> {
  const existingFileEntries = await filterExistingWorkspaceFiles(workDir, fileEntries);
  const hasMissingFileDiagnostic = /\berror TS6053:/i.test(rawOutput);
  if (!hasMissingFileDiagnostic && existingFileEntries.length === fileEntries.length) {
    return null;
  }

  return buildScopedPackageTypecheckCmd(workDir, packageDir, existingFileEntries, sessionId);
}

async function removeScopedTypecheckConfigs(
  workDir: string,
  packageDir: string,
  sessionId: string,
): Promise<void> {
  const packagePath = join(workDir, packageDir);
  const configPrefix = `${SCOPED_TYPECHECK_CONFIG_PREFIX}${sessionId}-`;
  let entries: string[];
  try {
    entries = await readdir(packagePath);
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(configPrefix) && entry.endsWith('.json'))
      .map(async (entry) => {
        try {
          await unlink(join(packagePath, entry));
        } catch {
          // Ignore cleanup races; a fresh config will still be written below.
        }
      }),
  );
}

function parseRelativeImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bimport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier?.startsWith('.')) {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers];
}

async function resolveScopedImportSpecifier(
  workDir: string,
  packageDir: string,
  importerDir: string,
  specifier: string,
): Promise<string | null> {
  const base = normalize(join(importerDir, specifier));
  const candidates = new Set<string>([base]);
  const transpiledExtensionMatch = base.match(/\.(?:[cm]?js|jsx)$/);
  if (transpiledExtensionMatch) {
    candidates.add(base.slice(0, -transpiledExtensionMatch[0].length));
  }

  for (const candidate of [...candidates]) {
    for (const resolved of [
      candidate,
      ...SCOPED_TYPECHECK_EXTENSIONS.map((extension) => `${candidate}${extension}`),
      ...SCOPED_TYPECHECK_EXTENSIONS.map((extension) => join(candidate, `index${extension}`)),
    ]) {
      if (resolved.startsWith('..')) {
        continue;
      }

      if (await pathExists(join(workDir, packageDir, resolved))) {
        return normalize(resolved).replace(/\\/g, '/');
      }
    }
  }

  return null;
}

interface TypeScriptDiagnostic {
  filePath: string;
  text: string;
}

function parseTypeScriptDiagnostics(
  output: string,
  packageDirPath: string,
): TypeScriptDiagnostic[] {
  const diagnostics: TypeScriptDiagnostic[] = [];
  const lines = output.split('\n');
  const startPattern = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;

  let currentPath: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentPath || currentLines.length === 0) {
      currentPath = null;
      currentLines = [];
      return;
    }

    diagnostics.push({
      filePath: currentPath,
      text: currentLines.join('\n').trim(),
    });
    currentPath = null;
    currentLines = [];
  };

  for (const line of lines) {
    const match = line.match(startPattern);
    if (match) {
      flush();
      currentPath = normalizeDiagnosticPath(match[1] ?? '', packageDirPath);
      currentLines = [line];
      continue;
    }

    if (currentLines.length > 0) {
      currentLines.push(line);
    }
  }

  flush();
  return diagnostics;
}

function normalizeDiagnosticPath(reportedPath: string, packageDirPath: string): string {
  const trimmed = reportedPath.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (isAbsolute(trimmed)) {
    return normalize(trimmed);
  }

  const normalizedTrimmed = trimmed.replace(/\\/g, '/');
  const packageSegments = normalize(packageDirPath).split(/[\\/]/).slice(-2);
  const packagePrefix = packageSegments.join('/');

  if (packagePrefix && normalizedTrimmed.startsWith(`${packagePrefix}/`)) {
    return normalize(resolve(packageDirPath, normalizedTrimmed.slice(packagePrefix.length + 1)));
  }

  if (/^(apps|packages)\//.test(normalizedTrimmed)) {
    return normalize(resolve(packageDirPath, '..', '..', normalizedTrimmed));
  }

  return normalize(resolve(packageDirPath, trimmed));
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function filterExistingWorkspaceFiles(workDir: string, paths: string[]): Promise<string[]> {
  const existing: string[] = [];

  for (const path of dedupe(paths)) {
    if (!isScopeFilePath(path)) {
      existing.push(path);
      continue;
    }

    if (await pathExists(join(workDir, path))) {
      existing.push(path);
    }
  }

  return existing;
}

async function safeReadText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

function resolveWorkspacePackageDir(entry: string): string | null {
  const match = entry.match(/^((?:packages|apps)\/[^/]+)/);
  return match?.[1] ?? null;
}

function isScopeFilePath(entry: string): boolean {
  return /\.[a-z0-9]+$/i.test(entry);
}

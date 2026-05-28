import type { PipelineTemplate } from '../../types.js';
import {
  ACCEPTANCE_VERIFICATION_REVIEW_GUIDANCE,
  IMPLEMENTATION_QUALITY_REVIEW_GUIDANCE,
  PRODUCTION_READINESS_REVIEW_GUIDANCE,
  SECURITY_AUDIT_STAGE_GUIDANCE,
  SECURITY_ISOLATION_REVIEW_GUIDANCE,
  UX_DESIGN_AUDIT_STAGE_GUIDANCE,
  WIRING_VERIFICATION_REVIEW_GUIDANCE,
} from '../model-review-prompts.js';
import { withHelixRepoNativeTools } from '../native-tools.js';
import { withCodexReviewFallback } from './review-models.js';

const MINUTE_MS = 60_000;
const CLAUDE_OPUS_4_7_MODEL = 'claude-opus-4-7';
const VERIFICATION_BOOTSTRAP_TIMEOUT_MS = 4 * MINUTE_MS;
const FOCUSED_ANALYSIS_TIMEOUT_MS = 4 * MINUTE_MS;
const IMPLEMENTATION_TIMEOUT_MS = 18 * MINUTE_MS;
const IMPLEMENTATION_QUALITY_TIMEOUT_MS = 6 * MINUTE_MS;
const SECURITY_AUDIT_TIMEOUT_MS = 5 * MINUTE_MS;
const UX_DESIGN_AUDIT_TIMEOUT_MS = 5 * MINUTE_MS;
const REVIEW_TIMEOUT_MS = 6 * MINUTE_MS;
const REGRESSION_TIMEOUT_MS = 8 * MINUTE_MS;
const REGRESSION_QUALITY_TIMEOUT_MS = 4 * MINUTE_MS;

/**
 * Focused Change Pipeline
 *
 * Fast path for small, explicit feature-audit work items that look like a
 * targeted fix/change rather than a repo-wide audit. Keeps one short analysis
 * pass, then moves directly into implementation, review, and scoped regression.
 */
export const focusedChangePipeline: PipelineTemplate = {
  name: 'Focused Change',
  description: 'Fast path for small, explicit feature changes with scoped verification',
  applicableTo: ['feature-audit'],
  stages: [
    {
      name: 'Verification Bootstrap',
      type: 'bootstrap',
      description:
        'Prepare the scoped verification substrate before analysis so focused fixes do not burn turns rediscovering generated type noise or missing workspace declaration outputs.',
      model: { primary: { engine: 'claude-code' } },
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: VERIFICATION_BOOTSTRAP_TIMEOUT_MS,
    },
    {
      name: 'Focused Analysis',
      type: 'deep-scan',
      description: 'Read the small scoped area, identify the minimal safe change, then implement',
      model: {
        primary: {
          engine: 'codex-cli',
          model: 'gpt-5.5',
          effort: 'medium',
          maxTurns: 35,
        },
        fallback: {
          engine: 'claude-code',
          model: 'sonnet',
          maxTurns: 50,
          maxBudgetUsd: 10,
        },
      },
      outputSchema: { id: 'analysis-report' },
      tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: FOCUSED_ANALYSIS_TIMEOUT_MS,
    },
    {
      name: 'Implement Focused Change',
      type: 'implementation',
      description: 'Implement the smallest correct change for the scoped issue',
      model: {
        primary: {
          engine: 'codex-cli',
          model: 'gpt-5.5',
          effort: 'medium',
          permissionMode: 'bypassPermissions',
        },
        layered: [
          {
            engine: 'claude-code',
            model: 'opus',
            maxTurns: 12,
            maxBudgetUsd: 8,
          },
        ],
      },
      tools: withHelixRepoNativeTools(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']),
      canLoop: true,
      maxLoopIterations: 3,
      timeoutMs: IMPLEMENTATION_TIMEOUT_MS,
      qualityGate: {
        name: 'Focused Change Quality',
        checks: [
          { name: 'TypeScript compiles', type: 'typecheck' },
          { name: 'Scoped verification passes', type: 'test' },
          { name: 'Code formatted', type: 'lint' },
          {
            name: 'Change is durable and proportionate',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              effort: 'medium',
              maxTurns: 15,
              maxBudgetUsd: 8,
            }),
            tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: IMPLEMENTATION_QUALITY_REVIEW_GUIDANCE,
          },
          {
            name: 'Wiring and consumer verification',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              effort: 'medium',
              maxTurns: 12,
              maxBudgetUsd: 6,
            }),
            tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: WIRING_VERIFICATION_REVIEW_GUIDANCE,
          },
          {
            name: 'Security and isolation verification',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 12,
              maxBudgetUsd: 6,
            }),
            tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: SECURITY_ISOLATION_REVIEW_GUIDANCE,
          },
        ],
        passThreshold: 1.0,
        failAction: 'loop',
        timeoutMs: IMPLEMENTATION_QUALITY_TIMEOUT_MS,
      },
    },
    {
      name: 'Security Audit',
      type: 'review',
      description:
        'Claude Opus 4.7 performs a focused security/isolation audit on the scoped change and remediates scoped issues before broader review.',
      model: {
        primary: {
          engine: 'claude-code',
          model: CLAUDE_OPUS_4_7_MODEL,
          maxTurns: 15,
          maxBudgetUsd: 10,
          permissionMode: 'acceptEdits',
        },
      },
      outputSchema: { id: 'analysis-report', strict: true },
      prompt: `You are performing the HELIX Security Audit stage.

## Feature
Title: {{title}}
Description: {{description}}
Scope: {{scope}}

## Previous Iteration Output
{{previousOutput}}

${SECURITY_AUDIT_STAGE_GUIDANCE}`,
      tools: withHelixRepoNativeTools(['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash']),
      canLoop: true,
      maxLoopIterations: 2,
      timeoutMs: SECURITY_AUDIT_TIMEOUT_MS,
      qualityGate: {
        name: 'Security Audit Clearance',
        checks: [{ name: 'No blocking security findings remain', type: 'analysis-report-clear' }],
        passThreshold: 1.0,
        failAction: 'loop',
      },
    },
    {
      name: 'UX Design Audit',
      type: 'review',
      description:
        'Claude Opus 4.7 performs a focused UX/accessibility audit on the scoped change and remediates scoped issues before broader review.',
      model: {
        primary: {
          engine: 'claude-code',
          model: CLAUDE_OPUS_4_7_MODEL,
          effort: 'medium',
          maxTurns: 15,
          maxBudgetUsd: 10,
          permissionMode: 'acceptEdits',
        },
      },
      outputSchema: { id: 'analysis-report', strict: true },
      prompt: `You are performing the HELIX UX Design Audit stage.

## Feature
Title: {{title}}
Description: {{description}}
Scope: {{scope}}

## Previous Iteration Output
{{previousOutput}}

${UX_DESIGN_AUDIT_STAGE_GUIDANCE}`,
      tools: withHelixRepoNativeTools(['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash']),
      canLoop: true,
      maxLoopIterations: 2,
      timeoutMs: UX_DESIGN_AUDIT_TIMEOUT_MS,
      qualityGate: {
        name: 'UX Design Audit Clearance',
        checks: [{ name: 'No blocking UX findings remain', type: 'analysis-report-clear' }],
        passThreshold: 1.0,
        failAction: 'loop',
      },
    },
    {
      name: 'Focused Review',
      type: 'review',
      description: 'Perform one architectural/correctness review over the focused change',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'opus',
          maxTurns: 15,
          maxBudgetUsd: 10,
        },
      },
      outputSchema: { id: 'analysis-report' },
      tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob']),
      canLoop: true,
      maxLoopIterations: 2,
      timeoutMs: REVIEW_TIMEOUT_MS,
    },
    {
      name: 'Focused Regression',
      type: 'regression',
      description: 'Run scoped regression to confirm the targeted change holds',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'sonnet',
          maxTurns: 12,
          maxBudgetUsd: 6,
        },
      },
      outputSchema: { id: 'analysis-report' },
      tools: withHelixRepoNativeTools(['Bash', 'Read']),
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: REGRESSION_TIMEOUT_MS,
      qualityGate: {
        name: 'Focused Regression',
        checks: [
          { name: 'Scoped regression passes', type: 'test' },
          {
            name: 'Scenario-mapped Jira evidence exists',
            type: 'scenario-evidence',
          },
          {
            name: 'Acceptance verification',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 12,
              maxBudgetUsd: 6,
            }),
            tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: ACCEPTANCE_VERIFICATION_REVIEW_GUIDANCE,
          },
          {
            name: 'Production readiness verification',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 12,
              maxBudgetUsd: 6,
            }),
            tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: PRODUCTION_READINESS_REVIEW_GUIDANCE,
          },
          {
            name: 'Replay target seam coverage',
            type: 'replay-target-coverage',
          },
        ],
        passThreshold: 1.0,
        failAction: 'stop',
        timeoutMs: REGRESSION_QUALITY_TIMEOUT_MS,
      },
    },
  ],
};

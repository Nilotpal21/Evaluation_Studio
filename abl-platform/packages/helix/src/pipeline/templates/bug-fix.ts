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
import { withHelixDeliveryNativeTools, withHelixRepoNativeTools } from '../native-tools.js';
import { withCodexReviewFallback } from './review-models.js';

const MINUTE_MS = 60_000;
const CLAUDE_OPUS_4_7_MODEL = 'claude-opus-4-7';
const VERIFICATION_BOOTSTRAP_TIMEOUT_MS = 4 * MINUTE_MS;
const REPRODUCE_TIMEOUT_MS = 8 * MINUTE_MS;
const ROOT_CAUSE_TIMEOUT_MS = 10 * MINUTE_MS;
const IMPLEMENT_FIX_TIMEOUT_MS = 35 * MINUTE_MS;
const IMPLEMENT_FIX_QUALITY_TIMEOUT_MS = 8 * MINUTE_MS;
const SECURITY_AUDIT_TIMEOUT_MS = 6 * MINUTE_MS;
const UX_DESIGN_AUDIT_TIMEOUT_MS = 6 * MINUTE_MS;
const REGRESSION_TEST_TIMEOUT_MS = 10 * MINUTE_MS;
const REGRESSION_TEST_QUALITY_TIMEOUT_MS = 4 * MINUTE_MS;
const CODE_REVIEW_TIMEOUT_MS = 8 * MINUTE_MS;
const FULL_REGRESSION_TIMEOUT_MS = 15 * MINUTE_MS;
const FULL_REGRESSION_QUALITY_TIMEOUT_MS = 12 * MINUTE_MS;

function withDeliveryTools(tools: string[]): string[] {
  return withHelixDeliveryNativeTools(withHelixRepoNativeTools(tools));
}

/**
 * Bug Fix Pipeline
 *
 * Targeted flow for fixing a reported bug:
 *   Reproduce → Root Cause → Impact Analysis → Fix → Test → Review → Regress
 *
 * Model strategy:
 * - Reproduce/Root cause: Codex (deep code reading to trace the bug)
 * - Impact analysis: Codex with Claude layer (find all affected paths)
 * - Fix: Codex (minimal, correct change)
 * - Test: Codex (write failing test first, then fix)
 * - Review: Claude Opus (verify fix correctness)
 */
export const bugFixPipeline: PipelineTemplate = {
  name: 'Bug Fix',
  description: 'Reproduce, root-cause, fix, and regress a reported bug',
  applicableTo: ['bug-fix'],
  stages: [
    {
      name: 'Verification Bootstrap',
      type: 'bootstrap',
      description:
        'Prepare the scoped verification substrate before reproduction so HELIX can distinguish real bug evidence from generated typing noise or missing workspace dependency outputs.',
      model: { primary: { engine: 'claude-code' } },
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: VERIFICATION_BOOTSTRAP_TIMEOUT_MS,
    },

    // ─── Stage 1: Reproduce ───────────────────────────────────
    {
      name: 'Reproduce',
      type: 'reproduce',
      description: 'Read the bug report, trace the code path, write a failing test',
      model: {
        primary: {
          engine: 'codex-cli',
          model: 'gpt-5.5',
          effort: 'medium',
          permissionMode: 'bypassPermissions',
        },
      },
      outputSchema: { id: 'reproduction-report' },
      tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit']),
      canLoop: true,
      maxLoopIterations: 3,
      timeoutMs: REPRODUCE_TIMEOUT_MS,
      qualityGate: {
        name: 'Bug Reproduced',
        checks: [
          {
            name: 'Scoped failing test artifact exists',
            type: 'modified-test',
          },
        ],
        passThreshold: 1.0,
        failAction: 'loop',
      },
    },

    // ─── Stage 2: Root Cause Analysis ─────────────────────────
    {
      name: 'Root Cause Analysis',
      type: 'root-cause',
      description: 'Trace from symptom to root cause, identify all affected paths',
      model: {
        primary: {
          engine: 'codex-cli',
          model: 'gpt-5.5',
          effort: 'extra-high',
          permissionMode: 'bypassPermissions',
        },
        layered: [
          {
            engine: 'claude-code',
            model: 'opus',
            maxTurns: 15,
            maxBudgetUsd: 10,
            systemPrompt:
              'You are reviewing a root cause analysis. Verify: is this the TRUE root cause, or just a symptom? Are ALL affected code paths identified? Could this bug manifest elsewhere?',
          },
        ],
      },
      outputSchema: { id: 'analysis-report' },
      tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob']),
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: ROOT_CAUSE_TIMEOUT_MS,
    },

    // ─── Stage 3: User Checkpoint — Approve Fix Approach ──────
    {
      name: 'Fix Approach Approval',
      type: 'user-checkpoint',
      description: 'Review root cause and proposed fix approach. Approve to proceed.',
      model: { primary: { engine: 'claude-code' } },
      canLoop: false,
      maxLoopIterations: 1,
      checkpoint: 'user-approval',
    },

    // ─── Stage 4: Implement Fix ───────────────────────────────
    {
      name: 'Implement Fix',
      type: 'implementation',
      description: 'Apply the minimal, correct fix. Codex implements, Claude reviews.',
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
            maxTurns: 15,
            maxBudgetUsd: 10,
          },
        ],
      },
      tools: withDeliveryTools(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']),
      canLoop: true,
      maxLoopIterations: 3,
      timeoutMs: IMPLEMENT_FIX_TIMEOUT_MS,
      qualityGate: {
        name: 'Fix Quality',
        checks: [
          { name: 'TypeScript compiles', type: 'typecheck' },
          { name: 'Previously failing test now passes', type: 'test' },
          { name: 'Code formatted', type: 'lint' },
          {
            name: 'Fix is architecturally durable',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 20,
              maxBudgetUsd: 10,
            }),
            tools: withDeliveryTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: IMPLEMENTATION_QUALITY_REVIEW_GUIDANCE,
          },
          {
            name: 'Wiring and consumer verification',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 20,
              maxBudgetUsd: 8,
            }),
            tools: withDeliveryTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: WIRING_VERIFICATION_REVIEW_GUIDANCE,
          },
          {
            name: 'Security and isolation verification',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 20,
              maxBudgetUsd: 8,
            }),
            tools: withDeliveryTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: SECURITY_ISOLATION_REVIEW_GUIDANCE,
          },
        ],
        passThreshold: 1.0,
        failAction: 'loop',
        timeoutMs: IMPLEMENT_FIX_QUALITY_TIMEOUT_MS,
      },
    },

    // ─── Stage 5: Security Audit ──────────────────────────────
    {
      name: 'Security Audit',
      type: 'review',
      description:
        'Claude Opus 4.7 performs a dedicated security/isolation audit on the implemented fix and remediates scoped issues before broader verification.',
      model: {
        primary: {
          engine: 'claude-code',
          model: CLAUDE_OPUS_4_7_MODEL,
          maxTurns: 18,
          maxBudgetUsd: 12,
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
      tools: withDeliveryTools(['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash']),
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

    // ─── Stage 6: UX Design Audit ─────────────────────────────
    {
      name: 'UX Design Audit',
      type: 'review',
      description:
        'Claude Opus 4.7 performs a dedicated UX/accessibility audit on the implemented fix and remediates scoped issues before broader verification.',
      model: {
        primary: {
          engine: 'claude-code',
          model: CLAUDE_OPUS_4_7_MODEL,
          effort: 'medium',
          maxTurns: 18,
          maxBudgetUsd: 12,
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
      tools: withDeliveryTools(['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash']),
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

    // ─── Stage 7: Write Regression Test ───────────────────────
    {
      name: 'Regression Test',
      type: 'testing',
      description: 'Ensure the bug has a permanent regression test that would catch recurrence',
      model: {
        primary: {
          engine: 'codex-cli',
          model: 'gpt-5.5',
          effort: 'medium',
          permissionMode: 'bypassPermissions',
        },
      },
      outputSchema: { id: 'analysis-report' },
      tools: withDeliveryTools(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']),
      canLoop: true,
      maxLoopIterations: 2,
      timeoutMs: REGRESSION_TEST_TIMEOUT_MS,
      qualityGate: {
        name: 'Regression Test Quality',
        checks: [{ name: 'Test passes', type: 'test' }],
        passThreshold: 1.0,
        failAction: 'loop',
        timeoutMs: REGRESSION_TEST_QUALITY_TIMEOUT_MS,
      },
    },

    // ─── Stage 8: Review ──────────────────────────────────────
    {
      name: 'Code Review',
      type: 'review',
      description: 'Claude reviews the complete fix for correctness and completeness',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'opus',
          effort: 'medium',
          maxTurns: 20,
          maxBudgetUsd: 15,
        },
      },
      outputSchema: { id: 'analysis-report' },
      tools: withDeliveryTools(['Read', 'Grep', 'Glob']),
      canLoop: true,
      maxLoopIterations: 2,
      timeoutMs: CODE_REVIEW_TIMEOUT_MS,
    },

    // ─── Stage 9: Full Regression ─────────────────────────────
    {
      name: 'Full Regression',
      type: 'regression',
      description: 'Run the complete test suite to ensure no regressions',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'sonnet',
          maxTurns: 15,
          maxBudgetUsd: 10,
        },
      },
      outputSchema: { id: 'analysis-report' },
      tools: withDeliveryTools(['Bash', 'Read']),
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: FULL_REGRESSION_TIMEOUT_MS,
      qualityGate: {
        name: 'Full Regression',
        checks: [
          { name: 'All tests pass', type: 'test', command: 'pnpm test:report' },
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
              maxTurns: 15,
              maxBudgetUsd: 8,
            }),
            tools: withDeliveryTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: ACCEPTANCE_VERIFICATION_REVIEW_GUIDANCE,
          },
          {
            name: 'Production readiness verification',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 15,
              maxBudgetUsd: 8,
            }),
            tools: withDeliveryTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: PRODUCTION_READINESS_REVIEW_GUIDANCE,
          },
          {
            name: 'Replay target seam coverage',
            type: 'replay-target-coverage',
          },
        ],
        passThreshold: 1.0,
        failAction: 'stop',
        timeoutMs: FULL_REGRESSION_QUALITY_TIMEOUT_MS,
      },
    },
  ],
};

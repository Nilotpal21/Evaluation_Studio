import type { PipelineTemplate } from '../../types.js';
import { withHelixRepoNativeTools } from '../native-tools.js';

const MINUTE_MS = 60_000;

const VERIFICATION_BOOTSTRAP_TIMEOUT_MS = 2 * MINUTE_MS;
const IMPLEMENTATION_TIMEOUT_MS = 8 * MINUTE_MS;
const REGRESSION_TIMEOUT_MS = 4 * MINUTE_MS;

/**
 * Quick Fix Pipeline (ABLP-797)
 *
 * Cheapest possible path for a trivial / single-edit bug fix. The operator
 * trusts that the fix is small and unambiguous (one-liner, typo, config
 * tweak, obvious null guard) — no oracle constellation, no plan generation,
 * no architecture review, no security/UX audits, no full regression suite.
 *
 * Stages:
 *   1. Verification Bootstrap   (deterministic, ~1s, $0)
 *   2. Implement Quick Fix      (1 model call, codex-cli/gpt-5.5, $3-8)
 *   3. Quick Regression         (1 model call, sonnet, scoped tests, $1-3)
 *
 * Target wall time: 3-6 minutes
 * Target cost: $5-15 (vs $140-285 for Holistic Audit on the same fix)
 *
 * NOT for: new features, multi-file changes, anything touching exported
 * APIs, security-sensitive code, or work that needs an audit trail. Use
 * Holistic Audit (`helix audit`) or Bug Fix (`helix fix`) for those.
 *
 * Selection: explicit `--template quick-fix` or `helix quickfix` shorthand.
 * Never auto-selected — Helix can't reliably distinguish "trivial" from
 * "looks trivial but isn't" without operator judgment.
 */
export const quickFixPipeline: PipelineTemplate = {
  name: 'Quick Fix',
  description:
    'Cheapest path for trivial bug fixes — single-pass implementation with scoped regression. No oracles, no audit trail.',
  applicableTo: ['bug-fix', 'feature-audit'],
  stages: [
    {
      name: 'Verification Bootstrap',
      type: 'bootstrap',
      description:
        'Prepare the scoped verification substrate: clear generated type noise, prebuild scoped packages.',
      model: { primary: { engine: 'claude-code' } },
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: VERIFICATION_BOOTSTRAP_TIMEOUT_MS,
    },
    {
      name: 'Implement Quick Fix',
      type: 'implementation',
      description:
        'Implement the smallest correct fix for the described issue. No layered review — the operator chose this pipeline because they trust the fix is unambiguous.',
      model: {
        primary: {
          engine: 'codex-cli',
          model: 'gpt-5.5',
          effort: 'medium',
          permissionMode: 'bypassPermissions',
          maxTurns: 30,
        },
        fallback: {
          engine: 'claude-code',
          model: 'sonnet',
          maxTurns: 30,
          maxBudgetUsd: 5,
        },
        // No `layered:` — skipping the secondary review pass is the single
        // biggest cost win for this pipeline. Implementation quality is
        // verified by typecheck + scoped tests, not by another LLM pass.
      },
      tools: withHelixRepoNativeTools(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']),
      canLoop: true,
      maxLoopIterations: 2,
      timeoutMs: IMPLEMENTATION_TIMEOUT_MS,
      qualityGate: {
        name: 'Quick Fix Quality',
        checks: [
          { name: 'TypeScript compiles', type: 'typecheck' },
          { name: 'Scoped tests pass', type: 'test' },
          { name: 'Code formatted', type: 'lint' },
          // No model-review checks — deterministic-only verification.
        ],
        passThreshold: 1.0,
        failAction: 'loop',
      },
    },
    {
      name: 'Quick Regression',
      type: 'regression',
      description:
        'Run only the tests that touch the changed files. Skips the full repo regression suite — operator chose Quick Fix because the change is small and isolated.',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'sonnet',
          maxTurns: 15,
          maxBudgetUsd: 3,
        },
      },
      tools: withHelixRepoNativeTools(['Read', 'Bash', 'Grep', 'Glob']),
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: REGRESSION_TIMEOUT_MS,
    },
  ],
};
